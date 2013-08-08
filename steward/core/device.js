var events      = require('events')
  , stringify  = require('json-stringify-safe')
  , url         = require('url')
  , util        = require('util')
  , steward     = require('./steward')
  , utility     = require('./utility')
  , broker      = utility.broker
  ;


var logger   = exports.logger   = utility.logger('devices');
var devices  = exports.devices  = {};
var makers   = exports.makers   = {};

var db;


var id2device = exports.id2device = function(id) {
  var child, children, device, i, uid;

  if (!id) return null;

  for (uid in devices) {
    if (!devices.hasOwnProperty(uid)) continue;

    device = devices[uid];
    if (!device.device) continue;
    if (device.device.deviceID === id) return device.device;

    children = device.device.children();
    for (i = 0; i < children.length; i++) {
      child = children[i];
      if (child.deviceID === id) return child;
    }
  }

  return null;
};

var idlist = function() {
  var children, device, i, results, uid;

  results = [];
  for (uid in devices) {
    if (!devices.hasOwnProperty(uid)) continue;

    device = devices[uid];
    if (!device.device) continue;
    results.push(device.device.deviceID);
    children = device.device.children();
    for (i = 0; i < children.length; i++) results.push(children[i].deviceID);
  }
  return results;
};


exports.start = function() {
  db = require('./database').db;

  if (!db) {
    logger.warning('database not ready, retrying...');
    setTimeout(exports.start, 1 * 1000);
  }

  steward.actors.device =
      { $info   : { type       : '/device'
                  }
      , $lookup : id2device
      , $list   : idlist
      };
  utility.acquire(logger, __dirname + '/../devices', /^device-.*\.js/, 7, -3, ' driver');
// cf., utility.start()
  utility.acquiring--;

  utility.broker.subscribe('actors', function(request, taskID, actor, perform, parameter) {/* jshint unused: false */
    var d, data, i, ids, info;

    if ((request !== 'ping') || (!broker.has('beacon-egress'))) return;

    ids = idlist();
    data = [];
    for (i = 0; i < ids.length; i++) {
      d = id2device(ids[i]);
      if (!d) continue;

      if (!d.prev) {
        if (!!d.changed) d.changed();
        continue;
      }

      info = JSON.parse(d.prev);
      try { info.updated = d.updated.getTime(); } catch(ex) { info.updated = d.updated; }
      data.push(info);
    }
    if (data.length > 0) broker.publish('beacon-egress', '.updates', data);
  });
};


exports.review = function() {
  var state, states, d, i, ids;

  ids = idlist();
  states = { warning: 0, attention: 0, error: 0 };
  for (i = 0; i < ids.length; i++) {
    d = id2device(ids[i]);
    if (!d) continue;

    state = { waiting : 'warning'
            , busy    : 'warning'
            , reset   : 'attention'
            , error   : 'error'
            }[d.status];
    if (!!state) states[state]++;
  }

  return states;
};

exports.discover = function(info, callback) {
  var deviceType, deviceUID;

  deviceUID = info.id;
  if (!!devices[deviceUID]) {
    if (!!callback) callback(null, null);
    return;
  }

  if ((!info.ipaddress) && (!!info.url)) info.ipaddress = url.parse(info.url).hostname;
  devices[deviceUID] = { discovery : info };

  deviceType = (makers[info.deviceType] || (!info.deviceType2)) ? info.deviceType : info.deviceType2;
  if (!makers[deviceType]) {
    logger.warning('no maker registered for ' + info.deviceType);
    if (!!callback) callback({ message: 'no maker registered for ' + info.deviceType }, null);
    return;
  }

  db.get('SELECT deviceID FROM devices WHERE deviceUID=$deviceUID', { $deviceUID: deviceUID }, function(err, row) {
    if (err) {
      logger.error('devices', { event: 'SELECT device.deviceUID for ' + deviceUID, diagnostic: err.message });
    } else if (row !== undefined) {
      if (!!callback) callback(null, null);

      devices[deviceUID].device = new (makers[deviceType])(row.deviceID, deviceUID, info);
      devices[deviceUID].proplist = Device.prototype.proplist;
      logger.info('found ' + info.device.name, { deviceType: deviceType });
      return;
    }

    db.run('INSERT INTO devices(deviceUID, deviceType, deviceName, created) '
           + 'VALUES($deviceUID, $deviceType, $deviceName, datetime("now"))',
           { $deviceUID: deviceUID, $deviceType: deviceType, $deviceName: info.device.name }, function(err) {
      var deviceID;

      if (err) {
        logger.error('devices', { event: 'INSERT device.deviceUID for ' + deviceUID, diagnostic: err.message });
        if (!!callback) callback(err, null);
        return;
      }

      deviceID = this.lastID;

      devices[deviceUID].device = new (makers[deviceType])(deviceID, deviceUID, info);
      devices[deviceUID].proplist = Device.prototype.proplist;
      logger.notice('adding ' + info.device.name, { deviceType: deviceType });

      if (!!callback) callback(null, deviceID);
    });
  });
};


var Device = exports.Device = function() {
  var self = this;

  self.whatami = '/device';
  self.status = 'unknown';
  self.elide = [];
};
util.inherits(Device, events.EventEmitter);

Device.prototype.children = function() { return []; };

Device.prototype.proplist = function() {
  var i, info, self;

  self = this;
  info = utility.clone(!!self.info ? self.info : {});
  delete(info.name);
  if (!!self.elide) for (i = 0; i < self.elide.length; i++) if (!!info[self.elide[i]]) info[self.elide[i]] = '********';
  if (!!info.lastSample) info.lastSample = new Date(info.lastSample);

  return { whatami   : self.whatami
         , whoami    : 'device/' + self.deviceID
         , name      : !!self.name ? self.name : ''
         , status    : self.status
         , info      : info
         , updated   : !!self.updated ? new Date(self.updated) : null
         };
};

Device.prototype.getName = function() {
  var self = this;

  db.get('SELECT deviceName FROM devices WHERE deviceID=$deviceID',
         { $deviceID : self.deviceID }, function(err, row) {
    if (err) {
      logger.error('devices', { event: 'SELECT device.deviceName for ' + self.deviceID, diagnostic: err.message });
      return;
    }
    if (row !== undefined) {
      self.name = row.deviceName;
      self.changed();
    }
  });
};


Device.prototype.setName = function(deviceName) {
  var self = this;

  if (!deviceName) return false;

  db.run('UPDATE devices SET deviceName=$deviceName WHERE deviceID=$deviceID',
         { $deviceName: deviceName, $deviceID : self.deviceID }, function(err) {
    if (err) {
      logger.error('devices', { event: 'UPDATE device.deviceName for ' + self.deviceID, diagnostic: err.message });
    } else {
      self.name = deviceName;
      self.changed();
    }
  });

  return true;
};

Device.prototype.setInfo = function() {
  var self = this;

  var info = utility.clone(self.info);
  if (!info.id) info.id = self.deviceUID;
  if (!info.deviceType) info.deviceType = self.whatami;
  if (!info.device) info.device = { name: self.name };

  db.run('UPDATE deviceProps SET value=$value WHERE deviceID=$deviceID AND deviceProps.key="info"',
         { $value: JSON.stringify(info), $deviceID : self.deviceID }, function(err) {
    if (err) {
      logger.error('devices', { event: 'UPDATE deviceProps.value for ' + self.deviceID, diagnostic: err.message });
    } else self.changed();
  });

  return true;
};

Device.prototype.nv = function(v) {
  var b, h, r, u;

  r = /00$/;
  for (h = v.toString('hex'); r.test(h); h = h.replace(r, '')) ;
  if (h !== v.toString('hex')) {
    b = new Buffer(h, 'hex');
    u = b.toString('utf8');
    if (u === b.toString('ascii')) return u;
  }

  return v.toString('hex');
};

exports.lastupdated = new Date().getTime();

Device.prototype.changed = function(now) {
  var info, prev, updated;

  var self = this;

  now = now || new Date();
  now = now.getTime();

  self.updated = now;
  if (exports.lastupdated < now) exports.lastupdated = now;

  info = self.proplist();
  try { info.lastSample = info.lastSample.getTime(); } catch(ex) {}
  try { updated = info.updated.getTime(); } catch(ex) { updated = info.updated; }
  delete(info.updated);
  prev = stringify(info);
  if (self.prev === prev) return;
  self.prev = prev;
  info.updated = updated;

  if (broker.has('beacon-egress')) {
    broker.publish('beacon-egress', '.updates', info);
    if ((self.status === 'reset') || (self.status === 'error')) broker.publish('actors', 'attention');
  }
};


Device.prototype.alert = function(message) {
  var info, updated;

  var self = this;

  if (broker.has('beacon-egress')) {
    info = self.proplist();

    updated = (info.updated || new Date()).getTime();
    delete(info.updated);

    broker.publish('beacon-egress', '.updates',
                   { updated: updated, level: 'alert', message: message, whoami: info.whoami, name: info.name, info: info });
  }
};


exports.perform = function(self, taskID, perform, parameter) {
  var params;

  try { params = JSON.parse(parameter); } catch(ex) { params = {}; }

  if (perform !== 'set') return false;

  if (!!params.name) return self.setName(params.name);

  return false;
};

exports.validate_perform = function(perform, parameter) {
  var params = {}
    , result = { invalid: [], requires: [] }
    ;

  if (perform !== 'set') {
    result.invalid.push('perform');
    return result;
  }
  if (!parameter) {
    result.requires.push('parameter');
    return result;
  }

  try { params = JSON.parse(parameter); } catch(ex) { result.invalid.push('parameter'); }

  if (!params.name) result.requires.push('name');

  return result;
};

exports.rainbow =
{ error:     { color: 'red',    rgb: { r: 255, g:   0, b:   0 } }
, attention: { color: 'orange', rgb: { r: 255, g: 131, b:   0 } }
, warning:   { color: 'blue',   rgb: { r:   0, g:   0, b: 255 } }
, normal:    { color: 'green',  rgb: { r:   0, g: 255, b:   0 } }

};


var boundedValue = exports.boundedValue = function(value, lower, upper) {
  return ((isNaN(value) || (value < lower)) ? lower : (upper < value) ? upper : value);
};


exports.percentageValue = function(value, maximum) {
  return Math.floor((boundedValue(value, 0, maximum) * 100) / maximum);
};


exports.scaledPercentage = function(percentage, minimum, maximum) {
  return boundedValue(Math.round((boundedValue(percentage, 0, 100) * maximum) / 100), minimum, maximum);
};


exports.degreesValue = function(value, maximum) {
  return Math.floor((boundedValue(value, 0, maximum) * 360) / maximum);
};


exports.scaledDegrees = function(degrees, maximum) {
  while (degrees <    0) degrees += 360;
  while (degrees >= 360) degrees -= 360;

  return boundedValue(Math.round((degrees * maximum) / 360), 0, maximum);
};


exports.traverse = function(actors, prefix, depth) {
  var actor;

  if (!actors) return exports.traverse(steward.actors, '/', 1);

  for (actor in actors) {
    if (!actors.hasOwnProperty(actor)) continue; if (actor.indexOf('$') !== -1) continue;

    console.log('          '.substr(-(2*depth)) + prefix + actor + ': ' + (!!makers[prefix + actor]));
    exports.traverse(actors[actor], prefix + actor + '/', depth + 1);
  }
};

// expansion of '.[deviceID.property].'
exports.expand = function(line, defentity) {
  var entity, field, info, p, part, parts, result, who, x;

  result = '';
  while ((x = line.indexOf('.[')) >= 0) {
    if (x > 0) result += line.substring(0, x);
    line = line.substring(x + 2);

    x = line.indexOf('].');
    if (x === -1) {
      result += '.[';
      continue;
    }

    parts = line.substring(0, x).split('.');
    line = line.substring(x + 2);

    if (parts[0] === '') entity = defentity;
    else if (parts[0].indexOf('/') !== -1) {
      who = parts[0].split('/');
      entity = steward.actors[who[0]];
      if (!!entity) entity = entity.$lookup(who[1]);
    } else entity = id2device(parts[0]);

    if (!entity) {
      result += '.[';
      continue;
    }
    info = entity.info;
    field = '';
    for (p = 1; p < parts.length; p++) {
      part = parts[p];
           if (part === 'name')   field = entity.name;
      else if (part === 'status') field = entity.status;
      else if (!!info[part])      field = info[part];
      else break;
    }
    result += field;
  }
  result += line;

  return result;
};
