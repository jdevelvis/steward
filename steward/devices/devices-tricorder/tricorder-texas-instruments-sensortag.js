//
// http://www.ti.com/ww/en/wireless_connectivity/sensortag/index.shtml?INTC=SensorTag&HQS=sensortag-bt1

var sensortag   = require('sensortag')
  , util        = require('util')
  , devices     = require('./../../core/device')
  , steward     = require('./../../core/steward')
  , utility     = require('./../../core/utility')
  , sensor      = require('./../device-sensor')
  , tricorder   = require('./../device-tricorder')
  ;


var logger = tricorder.logger;


var SensorTag = exports.Device = function(deviceID, deviceUID, info) {
  var self = this;

  self.whatami = info.deviceType;
  self.deviceID = deviceID.toString();
  self.deviceUID = deviceUID;
  self.name = info.device.name;

  self.status = 'present';
  self.changed();
  self.peripheral = info.peripheral;
  self.sensor = new sensortag(self.peripheral);
  self.ble = info.ble;
  self.info = { rssi: self.peripheral.rssi };

  self.peripheral.on('connect', function() {
    self.peripheral.updateRssi();
  });

  self.peripheral.on('disconnect', function() {
    self.status = 'idle';
    self.changed();

    logger.info('device/' + self.deviceID, { status: self.status });
// TBD: handle connection timeout...
    setTimeout(function() { self.status = 'absent'; self.changed(); self.peripheral.connect(); }, 120 * 1000);
  });
  self.peripheral.on('rssiUpdate', function(rssi) {
    self.status = 'present';
    self.info.rssi = rssi;
    self.changed();

    logger.info('device/' + self.deviceID, { status: self.status });
  });

  self.sensor.discoverServices(function() {
console.log('>>> services discovered');
    self.sensor.discoverCharacteristics(function() {
console.log('>>> characteristics discovered');
      self.ready(self);
    });
  });

  utility.broker.subscribe('actors', function(request, taskID, actor, perform, parameter) {
    if (actor !== ('device/' + self.deviceID)) return;

    if (request === 'perform') return devices.perform(self, taskID, perform, parameter);
  });
};
util.inherits(SensorTag, tricorder.Device);

SensorTag.prototype.ready = function(self) {
console.log('>>> ready');
  self.sensor.enableHumidity(function(err) {
console.log('>>> humidity enabled');
    if (!!err) return logger.error('device/' + self.deviceID, { event: 'enableHumidity', diagnostic: err.message });

    var cb = function(temperature, humidity) {
console.log('>>> cb: ' + JSON.stringify({ temperature : temperature, humidity : humidity }));
      var didP, params;

      didP = false;
      params = {};

      if (self.info.temperature !== temperature) {
        didP = true;
        params.temperature = self.info.temperature = temperature;
      }
      if (self.info.humidity !== humidity) {
        didP = true;
        params.humidity = self.info.humidity = humidity;
      }
      
      if (!didP) return;
      sensor.update(self.deviceID, params);
      self.changed();
    };

    self.sensor.readHumidity(cb);
    self.sensor.on('humidityChange', cb);
    self.sensor.notifyHumidity(function(err) {
console.log('>>> notifyHumidity enabled');
      if (!!err) logger.error('device/' + self.deviceID, { event: 'enableHumidity', diagnostic: err.message });
    });
  });
};


exports.start = function() {
  steward.actors.device.tricorder['texas-instruments'] = steward.actors.device.tricorder['texas-instruments'] ||
      { $info     : { type       : '/device/tricorder/texas-instruments' } };

  steward.actors.device.tricorder['texas-instruments'].sensortag =
      { $info     : { type       : '/device/tricorder/texas-instruments/sensortag'
                    , observe    : [ ]
                    , perform    : [ ]
                    , properties : { name          : true
                                   , status        : [ 'present', 'absent', 'idle' ]
                                   , rssi          : 's8'
                                   , lastSample    : 'timestamp'
                                   , temperature   : 'celsius'
                                   , humidity      : 'percentage'
                                   , pressure      : 'millibars'

                                   , accelerometer : 'meters/second'
                                   }
                    }
      , $validate : { perform    : devices.validate_perform }
      };
  devices.makers['/device/tricorder/texas-instruments/sensortag'] = SensorTag;

  require('./../../discovery/discovery-ble').register(
    { 'Texas Instruments'       : { '2a00' : { 'TI BLE Sensor Tag' : { type : '/device/tricorder/texas-instruments/sensortag' }
                                             }
                                  }
    });
};
