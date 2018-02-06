//Import GSM modem package
var modem = require('modem').Modem()

//Import log manager
var winston = require('winston');
var path = require('path');

//Imports packages used to parse XML from remote stream
var https = require('https');
var parser = require('xml2js');
var concat = require('concat-stream');

//Imports package used to create a TCP server
var net = require('net');
var moment = require('moment');

//Used to reverse geocode latitude to address
var NodeGeocoder = require('node-geocoder')

//Used to search GSM tower cell geolocation
var geolocation = require('geolocation-360');

//Load service account from local JSON file
const serviceAccount = require("./firebaseAdmin.json");

//Import firebase admin SDK
const admin = require("firebase-admin");

//Initialize using google maps static api key
var geocoder = NodeGeocoder({
  provider: 'google',
  apiKey: 'AIzaSyAq8QebBfeR7sVRKErHhmysSk5U80Zn3xE', // for Mapquest, OpenCage, Google Premier
});

//Initialize using two providers (google and openCellId)
geolocation.initialize({
	googleApiKey: 'AIzaSyBBw803hHB7msBTnZ53YHdDWFPcJACIyCc',
	openCellIdApiKey: '9d604982096e3a'
});

//Initialize admin SDK
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://tracker-d3d7e.firebaseio.com"
});

//Load Firebase Firestore DB manager and Cloud Messaging
db = admin.firestore();
fcm = admin.messaging();

//Schedule periodic check (every minute)
setInterval(system_check, 60 * 1000);

//Get process params
comPort = process.argv[2];
serverName = process.argv[3];

//Initialize tracker array
var trackers = {};

//Initialize SMS array
var sms_sent = {};

//Initialize XML responses array
var xmlResponses = [];

//Initialize logger
var logger = initializeLog();

//Log initalization
logger.info('Application initialized, dependencies loaded successfully');

//Initialize TCP Server
initializeTCPServer();

//Initialize modem
initializeModem();

//Start monitoring trackers
monitorTrackers();

//Runs periodically to check server status (TODO: Check TCP Connectitivy)
function system_check() 
{
  //Log data
  logger.debug('Running periodic check');

  //Check modem status
  if(modem != null && modem.isOpened)
  {
    //Execute check on modem (AT -> must return 'OK')
    modem.execute("AT", function (escape_char, response) 
    {
      //Check response
      if(response != "OK")
      {
        //Log error
        logger.error("Error on scheduled modem check: " + response);

        //Try to close modem connection
        modem.close();
      }
    });
  }
  else
  {
    //Log warning
    logger.warn("Periodic check: Modem not working properly")
  }

  //Perform check on trackers
  for(var id in trackers)
  {
    //Perform periodic check on tracker
    checkTracker(id, trackers[id])
  }
}

function initializeLog()
{
  //Define application log format
  const logFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(function (info) {
      const { timestamp, level, message, ...args} = info;

      return `${info.timestamp} - ${info.level}: ${info.message} ${Object.keys(args).length ? JSON.stringify(args, null, 2) : ''}`;
    })
  );

  //Create application logger
  return winston.createLogger({
    transports: 
    [
      new winston.transports.Console({ 
        format: winston.format.combine(winston.format.colorize(), logFormat),
        handleExceptions: true
      }), 
      new winston.transports.File({ 
        filename: path.join(__dirname, 'warning.log'),
        level: 'warning', 
        format: logFormat,
        maxsize: 5000000, 
        maxfiles: 10 }),
      new winston.transports.File({ 
        filename: path.join(__dirname, 'info.log'), 
        level: 'info', 
        format: logFormat,
        maxsize: 5000000, 
        maxfiles:10 }),
      new winston.transports.File({ 
        filename: path.join(__dirname, 'debug.log'), 
        format: logFormat,
        maxsize: 1000000, 
        maxfiles: 20 })
    ],
    exceptionHandlers: [
        new winston.transports.File({filename: path.join(__dirname, 'exceptions.log')})
    ], 
    exitOnError: false,
    level: 'debug'
  });
}

function initializeModem()
{
  //Error handling'
  modem.on("error", error =>
  {
    //Log error
    logger.error("Connection to modem failed: " + error);

    //Close connection to modem
    modem.close();

  });

  //Open connection on modem serial port
  modem.open(comPort, result =>
  {
    //On command sent to modem
    modem.on('command', function(command) {

      //Log command
      logger.debug("Modem <- [" + command + "]");
    });

    //Execute modem configuration (RESET MODEM)
    modem.execute("ATZ");

    //Execute modem configuration (DISABLE ECHO)
    modem.execute("ATE0");

    //Execute modem configuration (ENABLE TX/RX)
    modem.execute("AT+CFUN=1");

    //Execute modem configuration (SET PDU MODE)
    modem.execute("AT+CMGF=0");

    //Execute modem configuration (ENABLE ERROR MESSAGES)
    modem.execute("AT+CMEE=2");

    //Execute modem configuration (REQUEST DELIVERY REPORT)
    modem.execute("AT+CSMP=49,167,0,0");

    //Execute modem command (REQUEST MANUFACTURER)
    modem.execute("AT+CGMI", function(response)
    {
      //If this is a HUAWEI MODEM
      if(response.includes('huawei'))
      {
        //Execute modem configuration (REQUEST SMS NOTIFICATION - HUAWEI)
        modem.execute("AT+CNMI=2,1,0,2,0");
      }
      else
      {
        //Execute modem configuration (REQUEST SMS NOTIFICATION - DLINK)
        modem.execute("AT+CNMI=2,1,0,1,0");
      }
    });

    //Execute modem command (REQUEST PHONE NUMBER)
    modem.execute("AT+CNUM", function(response)
    {
      //Get start index from the phone number
      var startIndex = response.indexOf('55');

      //If this is a HUAWEI MODEM
      if(startIndex > 0)
      {
        //Remove first part of response string
        response = response.substring(startIndex);

        //Get phone number
        modem.phoneNumber = response.substring(2, response.indexOf('"'));

        //Log information
        logger.info("Modem phone number retrieved: " + modem.phoneNumber);
      }
      else
      {
        //Log error
        logger.error("Error retrieving phone number: " + response);
      }
    });

    //On SMS received
    modem.on('sms received', function(sms) 
    {
      //Call method to handle sms
      handleSMSReceived(sms);

    });

    //On data received from modem
    modem.on('data', function(data) {

      //Log any data ouput from modem
      logger.debug("Modem -> [" + data.join().replace(/(\r\n|\n|\r)/gm,"") + "]");
    });
    
    //On SMS delivery receipt received
    modem.on('delivery', function(delivery_report) 
    {
      //Call mehtod to handle delivery report
      handleDeliveryReport(delivery_report);
    });

    //On modem memmory full
    modem.on('memory full', function(sms) 
    {
      //Execute modem command (DELETE ALL MESSAGES)
      modem.execute("AT+CMGD=1,4", function(escape_char, response) 
      {
        //Log data
        logger.info("Modem memory full, erasing SMS: " + response)
      });
    });

    //On modem connection closed
    modem.on('close', function() 
    {
      //Log warning 
      logger.debug("Modem connection closed, trying to open again...");

      //Initialize modem again in 5 seconds
      setTimeout(initializeModem, 5000);
    });
  });
}

//Initialize TCP server
function initializeTCPServer()
{
  //Create TCP server manger
  var server = net.createServer();  

  //Define actions on new TCP connection
  server.on('connection', conn => 
  {
    //Log connection
    logger.info('TCP (' +  conn.remoteAddress + ") -> Connected");

    //Set enconding
    conn.setEncoding('utf8');

    //On receive data from TCP connection
    conn.on('data', data => {

      //Log data received
      logger.debug("TCP (" + conn.remoteAddress + ') -> [' + data.replace(/\r?\n|\r/, '') + ']');

      //Check if data received is from a ST910/ST940 model
      if(data.startsWith("ST910"))
      {
        //Parse data
        parseST940(data, conn);
      } 
      else
      {
        //Log warning
        logger.warn("TCP data received from unknown tracker model");
      }

    });

    //On TCP connection close
    conn.once('close', function () {
      
      //Log info
      logger.info('TCP (' +  conn.remoteAddress + ") -> Disconnected");
    });

    //On TCP connection error
    conn.on('error', err => {

      //Log error
      logger.error('TCP (' +  conn.remoteAddress + ") -> Error: " + err.message);
    });

  });

  //Start listening on port 5001
  server.listen(5001, function() {  

    //Log info
    logger.info('TCP server listening to port: ' +  server.address().port);
  });
}

function handleSMSReceived(sms)
{
  //Log output
  logger.debug("SMS RECEIVED", sms);

  //Search tracker using sms phone number
  var tracker_id = formatPhoneNumber(sms.sender);

  //If tracker available
  if(trackers[tracker_id])
  {
    //If it is a delivery confirmation 
    if(sms.text.indexOf('entregue') > 0)
    {
      //Just log data (delivery report is handled it's own method)
      logger.debug('Received SMS delivery report from ' + trackers[tracker_id].name);
      
      //Message not relevant, delete from memmory
      modem.deleteMessage(sms);
    }
    else
    {
      //Save message on firestore DB
      db.collection("Tracker/" + tracker_id + "/SMS_Received")
      .doc(moment().format('YYYY/MM/DD_hh:mm:ss:SSS'))
      .set(
      {
        to: modem.phoneNumber, 
        receivedTime: sms.time,
        text: sms.text.replace(/\0/g, '')
      })
      .then(() => 
      {
        // Message already saved on DB, delete from modem memmory
        modem.deleteMessage(sms);

      });

      //Send notification to users subscribed on this topic
      sendNotification(tracker_id, "NotifyAvailable", {
        title: "Recebimento de SMS",
        content: "SMS enviado pelo rastreador foi recebido.",
        expanded: "SMS enviado pelo rastreador foi recebido: \n\n" + sms.text.replace(/\0/g, ''),
        datetime: sms.time.getTime().toString()
      });

      //Check tracker model 
      if(trackers[tracker_id].model === "TK 102B")
      {
        //parse message
        parseTK102B(tracker_id, sms);
      }
      else 
      {
        //Log warning
        logger.warn("Failed to parse message from tracker " + tracker + ": Unknown model");

        //Message already parsed, delete from memmory
        modem.deleteMessage(sms);
      }
    }
  }
  else
  {
    //Log warning
    logger.warn("Received SMS from unknown number");

    //Save on firestore DB global SMS Received collection
    db.collection("SMS_Received")
      .doc(moment().format('YYYY_MM_DD_hh_mm_ss_SSS'))
      .set(
      {
        server: serverName,
        to: modem.phoneNumber, 
        from: sms.sender,
        receivedTime: sms.time,
        text: sms.text.replace(/\0/g, '')
      });
    
    //Message already parsed, delete from memmory
    modem.deleteMessage(sms);
  }
}

function handleDeliveryReport(delivery_report)
{
  //Log delivery receipt
  logger.info("DELIVERY RECEIPT RECEIVED", delivery_report)

  //Initialize notification params
  notificationParams = { datetime: Date.now().toString() }

  //If report is indicating success
  if(delivery_report.status == "00")
  {
    //Set title and content
    notificationParams.title = "Alerta de disponibilidade";
    notificationParams.content = "Confirmou o recebimento de SMS";
  }
  else
  {
    //Set title and content
    notificationParams.title = "Alerta de indisponibilidade";
    notificationParams.content = "Rastreador não disponível para receber SMS";
  }

  //Try to get sms from sms_sent array
  sms = sms_sent[delivery_report.reference]

  //If sms_sent is available
  if(sms)
  {
    //Get tracker ID
    tracker_id = sms.tracker_id;

    //Append SMS text on notification
    notificationParams.expanded = "Confirmou o recebimento do SMS: " + sms.text;

    //Update data on firestore DB
    db.doc('Tracker/' + tracker_id + '/SMS_Sent/' + sms.id).update({
      receivedTime: new Date(),
      status: 'DELIVERED'
    });
  } 
  else
  {
    //Try to get tracker ID from 
    tracker_id = formatPhoneNumber(delivery_report.sender);
  }

  //If tracker ID is available
  if(trackers[tracker_id])
  {
    //Send notification
    sendNotification(tracker_id, "NotifyAvailable", notificationParams);

    //Log data
    logger.info("Received delivery report from " + trackers[tracker_id].name);
  }
  else
  {
    //Log warning
    logger.warn("Received delivery report from unknown number: " + delivery_report.sender);
  }
}

function sendNotification(tracker_id, topic, params)
{
  // Save tracker ID on param data
  params.id = tracker_id;

  // Create topic structure
  topic = tracker_id + "_" + topic;

  // Send a message to devices subscribed to the provided topic.
  fcm.sendToTopic(topic, { data: params }, 
  {
    priority: "high",
    timeToLive: 60 * 60 * 24,
    collapseKey: topic
  })
  .then(function(response) {
    // See the MessagingTopicResponse reference documentation for the
    logger.debug("Successfully sent message to topic " + topic + ":", response);
  })
  .catch(function(error) {
    logger.warn("Error sending message to topic " + topic + ":", error);
  });
}

//Get a real time updates from Firestore DB -> Tracker collection
function monitorTrackers()
{
  //Log data
  logger.debug("Initializing listener on Tracker collection")

  //Initialize listener
  db.collection("Tracker").onSnapshot(querySnapshot => 
  {
      //For each tracker load from snapshot
      querySnapshot.docChanges.forEach(docChange => 
      {
        //Log data
        logger.info("Tracker " + docChange.type + ": " + docChange.doc.get('name'));
    
        //If tracker is inserted or updated
        if(docChange.type === 'added' || docChange.type === 'modified')
        {
          //Save tracker on array
          trackers[docChange.doc.id] = docChange.doc.data();
    
          //Initialize update counter
          trackers[docChange.doc.id].updateAttempts = 0;
    
          //Perform initial check on tracker
          checkTracker(docChange.doc.id, trackers[docChange.doc.id]);
        } 
        else if(docChange.type === 'removed')
        {
          //Remove tracker from array
          delete trackers[docChange.doc.id];
        }
      });
      
    }, err => {
    
      //Log error
      logger.error('Error on tracker snapshot listener', err);

      //Try to start method again
      monitorTrackers();
      
    });
}

function checkTracker(tracker_id)
{
  //Get current datetime
  var currentDate = new Date();

  db
  .collection("Tracker/" + tracker_id + "/Configurations")
  .get()
  .then(configurations => 
  {
    //For each available configuration from this tracker
    configurations.forEach(function(config) 
    {
      //Get data from document snapshot
      config = config.data();

      //If a new config is REQUESTED, or last update on this config is more than one day
      if(config.status.step === "REQUESTED" || currentDate - config.status.datetime > (1000*60*60*24))
      {
        //Check if config can be executed (is not running on other server)
        if(checkConfigProgress(config))
        {
          //Save change on DB
          db.doc("Tracker/" + tracker_id + "/Configurations/" + config.name).set(config);

          //Get tracker model
          switch(trackers[tracker_id].model)
          {
            case "tk102b":

              //Call method to configure TK 102B device
              configTK102b(tracker_id, config);
              break;
            
            case "st940":

              //Call method to configure Suntech ST-940 device
              configST940(tracker_id, config);
              break;
          }
        }
      }
    });
  })
  .catch(function(error) 
  {
      //Log error message
      logger.error("Error getting tracker configuration: ", error);
  });  
}

function checkConfigProgress(config)
{
  //Check if update is already in progress
  if(config.status.inProgress)
  {
    //If this is the server currently applying configuration
    if(config.status.server == serverName)
    {
      //Increase update attempt counter
      config.status.updateAttempt++
    }
    else if(config.status.updateAttempt > 3)
    {
      //Other server already tried to execute this config more than 3 times
      config.status.server = serverName;

      //This server will now begin to apply this configuration
      config.status.updateAttempt = 1;
    }
    else
    {
      //Other server is currently trying to update this configuration, wait for result
      return false;
    }
  }
  else
  {
    //Set config in proggress flag
    config.status.inProgress = true;
    config.status.server = serverName;
    config.status.updateAttempt = 1;
  }

  //Config is ready to be sent to tracker
  return true;
}


function configTK102b(tracker_id, configuration)
{
  //Command to be sent by SMS to this tracker
  var command;

  //Check configuration name
  switch(configuration.name)
  {
    case "MoveOut":
      //Move out alert
      command = 'move123456 ' + configuration.value;
      break;

    case "OverSpeed":
      //Speed limit alert
      command = 'speed123456 ' + configuration.value;
      break;

    case "PeriodicUpdate":

      //Send SMS to request position and define callback
      command = 't' + configuration.value + 's***n123456';
      break;

    case "Shock":

      //Send SMS to request position and define callback
      command = 'shock123456';
      break;

    case "StatusCheck":

      //Send SMS to request position and define callback
      command = 'check123456';
      break;
  }

  //Send SMS to request command
  send_sms(id, command, function () {

    //Update configuration data on SMS successfully sent
    configuration.status.step = "SMS_SENT";
    configuration.status.description = "Status: Mensagem enviada ao rastreador...";
    configuration.status.inProgress = false;
    configuration.status.datetime = new Date();

    //Save data on firestore DB
    db
    .collection("Tracker/" + id + "/Configurations")
    .doc(configuration.name)
    .set(configuration);
  });
}

function send_sms(id, command, callback)
{
  //Send command to request current position
  modem.sms({
    receiver: trackers[id].identification,
    text: command,
    encoding:'16bit'
  }, 
  function(result, message_id) 
  {
    //if any error ocurred
    if(result == "SENT")
    {
      //Create an ID based on current datetime
      sms_id = moment().format('YYYY_MM_DD_hh:mm:ss:SSS');

      //Save SMS sent on firestore DB
      db.collection("Tracker/" + id + "/SMS_Sent")
        .doc(sms_id)
        .set(
        {
          server: process.argv[3],
          from: modem.phoneNumber,
          text: command,
          reference: message_id,
          sentTime: new Date(),
          receivedTime: null,
          status: 'ENROUTE'
        })
        .then(function(docRef) 
        {
          //Log data
          logger.debug("SMS command [" + command + "] sent to tracker " + trackers[id].name + ": Reference: #" + message_id + " -> Firestore ID: " +  sms_id);

          //Save on sms_sent array
          sms_sent[message_id] = { 
            text: command, 
            id: sms_id,
            tracker_id: id
          };
        })
        .catch(function(error) 
        {
          //Log warning
          logger.warn("SMS command [" + command + "] sent to tracker " + trackers[id].name + ": Reference: #" + message_id + " -> Could not save on firestore: " + error);
        });

      //Invoke callback if provided
      if(callback)
        callback();
    }
    else
    {
      //Log error
      logger.warn('Error sending sms to tracker ' + tracker.name + ': ' + result);
    }
  });
}

function updateSPOT(tracker_id, tracker)
{
  //Perform request on SPOT TRACE shared data
  https.get('https://api.findmespot.com/spot-main-web/consumer/rest-api/2.0/public/feed/' + tracker.identification + '/message.xml', function(resp) {
  
    //On request error
    resp.on('error', function(err) 
    {
      //Log error
      logger.error("Failed to request spot trace XML feed: " + err);
    });

    //Concatenate request data
    resp.pipe(concat(function(buffer) {
      
      //Parse resulting buffer
      parser.parseString(buffer.toString(), function(err, result) 
      {
        if(err)
        {
          //Log error
          logger.error("Error parsing XML response from tracker " + tracker.name + ": " + err);
        }
        else 
        {
          try 
          {
            //For each result in feed
            result.response.feedMessageResponse[0].messages[0].message.reverse().forEach(function(message,index) 
            {
              //Check if this was not parsed before
              if(!xmlResponses.includes(message["id"][0]))
              {
                //Check if this coordinate exists on DB
                db.doc("Tracker/" + tracker_id + "/Coordinates/" + message["id"][0])
                  .get()
                  .then(docSnapshot => 
                  {
                    //if not added yet
                    if (!docSnapshot.exists) 
                    {
                      //Create coordinate object
                      coordinates = new admin.firestore.GeoPoint(parseFloat(message['latitude'][0]), parseFloat(message['longitude'][0]));

                      //Parse datetime
                      datetime = moment.utc(message['dateTime'][0], "YYYY-MM-DDThh:mm:ss").toDate();

                      //Parse speed
                      speed = (message['messageType'][0] === ("NEWMOVEMENT") ? 30 : 0);

                      //Parse battery level
                      batteryLevel = (message["batteryState"][0] === "GOOD" ? 80 : 30);

                      //Define tracker params to be updated
                      tracker_params = 
                      {
                        batteryLevel: batteryLevel,
                        signalLevel: 100,
                        lastCheck: new Date(),
                        lastCoordinateType: "GPS",
                        lastCoordinate: coordinates,
                        lastUpdate: datetime
                      };

                      //Define coordinates params to be inserted/updated
                      coordinate_params = 
                      {
                        id: message["id"][0],
                        datetime: datetime,
                        signalLevel: 100,
                        batteryLevel: batteryLevel,
                        position: coordinates,
                        speed: speed
                      }

                      //Insert coordinates
                      setTimeout(function() { insert_coordinates(tracker_id, tracker_params, coordinate_params) }, index*1000);

                      //Save on parsed xml responses
                      xmlResponses.push(message["id"][0]);
                    }
                  });
              }
            });

            //On success, update last check on tracker
            updateLastCheck(tracker_id, tracker, new Date());

            //Finished parsing data
            logger.info("Successfully parsed tracker " + tracker.name + " XML feed");
          } 
          catch (error) 
          {
            //Log error
            logger.error("Unexpected response in XML feed from " + tracker.name + ": " + error, result);
          }
        }
      });
    }));
  });
}

function parseTK102B(tracker_id, sms) 
{
  //Remove null bytes from string
  sms_text = sms.text.replace(/\0/g, '')

  //Check if received just confirmation to SMS delivery
  if(sms_text.startsWith('GSM: '))
  {
    //Get signal level from SMS text
    index = sms_text.indexOf('GSM: ') + 'GSM: '.length;
    signal_level = parseInt(sms_text.substring(index, sms_text.substring(index).indexOf('%') + index));

    //Get battery level from SMS text
    index = sms_text.indexOf('BATTERY: ') + 'BATTERY: '.length;
    battery_level = parseInt(sms_text.substring(index, sms_text.substring(index).indexOf('%') + index));

    //Update value on firestore DB
    db.doc("Tracker/" + tracker_id).update({
      signalLevel: signal_level,
      batteryLevel: battery_level
    })

    //Send notification to users subscribed on this topic
    sendNotification(tracker_id, "NotifyStatus", {
      title: "Atualização de status",
      content: "Bateria: " + battery_level + "% / Sinal GSM: " + signal_level + "%",
      datetime: sms.time.getTime().toString()
    });
    
    //Log info
    logger.info('Successfully parsed status message from: ' + trackers[tracker_id].name);
  } 
  else if(sms_text.indexOf('lac') >= 0 && sms_text.indexOf('mnc') >= 0)
  {
    //Initialize request params array
    requestParams = {};

    //Get LAC from SMS text
    index = sms_text.indexOf('lac');
    index += sms_text.substring(index).indexOf(':') + 1
    requestParams.lac = sms_text.substring(index, sms_text.substring(index).match(/\D/)["index"] + index);

    //Get CID from SMS text
    index = sms_text.indexOf('cid');
    index += sms_text.substring(index).indexOf(':') + 1
    requestParams.cid = sms_text.substring(index, sms_text.substring(index).match(/\D/)["index"] + index);

    //Get MCC from SMS text
    index = sms_text.indexOf('mcc');
    index += sms_text.substring(index).indexOf('=') + 1
    requestParams.mcc = sms_text.substring(index, sms_text.substring(index).match(/\D/)["index"] + index);
    
    //Get MNC from SMS text
    index = sms_text.indexOf('mnc');
    index += sms_text.substring(index).indexOf('=') + 1
    requestParams.mnc = sms_text.substring(index, sms_text.substring(index).match(/\D/)["index"] + index);

    //Log data
    logger.debug("Requesting geolocation from cell tower", requestParams);

    //will use requests available in order of api key provided
    geolocation.request(requestParams, (error, result) => 
    {  
      //If result is successfull
      if (result && result.latitude < 90 && result.longitude < 90) 
      {
        //Create coordinates object
        var coordinates = new admin.firestore.GeoPoint(result.latitude, result.longitude);

        //Define tracker params to be updated
        tracker_params = 
        {
          lastCoordinateType: "GSM",
          lastCoordinate: coordinates,
          lastUpdate: new Date()
        };

        //Define coordinates params to be inserted/updated
        coordinate_params = 
        {
          cell_id: requestParams.mcc + "_" + requestParams.mnc + "_" + requestParams.cid + "_" + requestParams.lac,
          batteryLevel: trackers[tracker_id].batteryLevel,
          signalLevel: trackers[tracker_id].signalLevel,
          datetime: new Date(),
          position: coordinates,
          speed: 0
        }
        
        //Insert coordinates on DB
        insert_coordinates(tracker_id, tracker_params, coordinate_params);
      } 
      else 
      {
        //Log error
        logger.error("Failed to geolocate data from GSM cell tower", requestParams);
      }
    });
  }
  else if(sms_text.startsWith('lat'))
  {
    //Get latitude from SMS text
    index = sms_text.indexOf('lat:') + 'lat:'.length;
    latitude = sms_text.substring(index, sms_text.substring(index).indexOf(' ') + index);

    //Get longitude from SMS text
    index = sms_text.indexOf('long:') + 'long:'.length;
    longitude = sms_text.substring(index, sms_text.substring(index).indexOf(' ') + index);

    //Get speed from SMS text
    index = sms_text.indexOf('speed:') + 'speed:'.length;
    speed = sms_text.substring(index, sms_text.substring(index).indexOf(' ') + index);

    //Create coordinates object
    var coordinates = new admin.firestore.GeoPoint(parseFloat(latitude), parseFloat(longitude));

    //Define tracker params to be updated
    tracker_params = 
    {
      lastCoordinateType: "GPS",
      lastCoordinate: coordinates,
      lastUpdate: new Date()
    };

    //Define coordinates params to be inserted/updated
    coordinate_params = 
    {
      batteryLevel: trackers[tracker_id].batteryLevel,
      signalLevel: trackers[tracker_id].signalLevel,
      datetime: new Date(),
      position: coordinates,
      speed: parseFloat(speed)
    }
      
    //Insert coordinates on DB
    insert_coordinates(tracker_id, tracker_params, coordinate_params);
  } 
  else
  {
    //Log warning
    logger.warn('Unable to parse message from TK102B model: ' + sms_text);
  }
}

//Parse data from Suntech ST910/ST940 models
function parseST940(data, conn)
{
  //Split data using ; separator
  var values = data.split(';');

  //"ST910;Emergency;696478;500;20180201;12:26:55;-23.076226;-054.206427;000.367;000.00;1;4.1;0;1;02;1865;c57704f358;724;18;-397;1267;255;3;25\r"
  if(values[0] === "ST910" && (values[1] === 'Emergency' || values[1] === 'Alert' || values[1] === 'Location'))
  {
    //Get tracker ID
    id = values[2];

    //Parse datetime
    datetime =  moment.utc(values[4] + "-" + values[5], "YYYYMMDD-hh;mm;ss").toDate();

    //Parse coordinate
    coordinates = new admin.firestore.GeoPoint(parseFloat(values[6]), parseFloat(values[7]));

    //Parse speed
    speed = parseFloat(values[8]);

    //Battery level
    batteryLevel = (parseFloat(values[11]) - 2.8) * 71;

    //Define tracker params to be updated
    tracker_params = 
    {
      batteryLevel: batteryLevel,
      signalLevel: 0,
      lastCheck: new Date(),
      lastCoordinateType: "GPS",
      lastCoordinate: coordinates,
      lastUpdate: datetime
    };

    //Define coordinates params to be inserted/updated
    coordinate_params = 
    {
      datetime: datetime,
      signalLevel: 0,
      batteryLevel: batteryLevel,
      position: coordinates,
      speed: speed
    }

    //If there is an loaded tracker with this id
    if(trackers[id])
    {
      //Insert coordinates on DB
      insert_coordinates(id, tracker_params, coordinate_params);
          
      //Send ACK command to tracker
      sendACK(id, values[0], conn);
    }
    else
    {
      //Check on DB if there is a tracker with this ID
      db.doc("Tracker/" + id)
        .get()
        .then(docSnapshot => 
        {
          //if there is no tracker with this ID
          if (!docSnapshot.exists) 
          {
            //Log info
            logger.info("New tracker (ST940#" + id + ") detected, inserting on DB.")
            
            //Else, create an entry on DB
            tracker_params.name = "Novo - ST940";
            tracker_params.model = "ST940";
            tracker_params.description = "Adicionado automaticamente";
            tracker_params.identification = id;
            tracker_params.updateInterval = 60;

            //Choose a random color to new tracker
            tracker_params.backgroundColor = ['#99ff0000', '#99ffe600', '#99049f1e', '#99009dff', '#9900ffee'][Math.floor((Math.random() * 4) + 1)]
          }

          //Insert new coordinates on DB
          insert_coordinates(id, tracker_params, coordinate_params);
          
          //Send ACK command to tracker
          sendACK(id, values[0], conn);
        });
    }
  }
}

function sendACK(id, model, conn)
{
  try
  {
    //Send ACK command to tracker
    conn.write('AT^'+ model + ';ACK;' + id);

    //Log data
    logger.debug('TCP (' + conn.remoteAddress + ') <- [AT^'+ model + ';ACK;' + id + ']')
  }
  catch(error)
  {
    //Log error
    logger.error('Error sending ACK to tracker #' + id);
  }
}


function updateLastCheck(id, tracker, currentDate)
{
  //Run check on tracker right now
  var tracker_reference = db.collection('Tracker').doc(id);

  //Update tracker lastcheck
  tracker_reference.update('lastCheck', currentDate);

  //Change value locally (offline persistence, avoid multiple updates if no internet connection)
  tracker.lastCheck = currentDate;
  
  //Clear update attempts counter
  tracker.updateAttempts = 0;
}

//Return the distance in meters between to coordinates
function distance(coordinates1, coordinates2) {
  
  // Math.PI / 180
  var p = 0.017453292519943295;

  // Calculatedistance
  var a = 0.5 - 
          Math.cos((coordinates2.latitude - coordinates1.latitude) * p)/2 + 
          Math.cos(coordinates1.latitude * p) * Math.cos(coordinates2.latitude * p) * 
          (1 - Math.cos((coordinates2.longitude - coordinates1.longitude) * p))/2;
  
  // 2 * R; R = 6371 km
  return 12742000 * Math.asin(Math.sqrt(a)); 
}

//Function to insert coordinates received by a tracker on DB
function insert_coordinates(tracker_id, tracker_params, coordinate_params)
{
  //Update tracker
  db.collection('Tracker')
    .doc(tracker_id)
    .set(tracker_params, { merge: true })
    .then(() => 
    {
      //Get latest coordinate from this tracker
      db.collection('Tracker/' + tracker_id + '/Coordinates')
      .orderBy('datetime', 'desc')
      .where('datetime', '<=', coordinate_params.datetime)
      .limit(1)
      .get()
      .then(function(querySnapshot) 
      {
        //Get result from query
        lastCoordinate = querySnapshot.docs[0];
        
        //If no coordinates available or the distance is less than 50 meters from current position
        if(lastCoordinate == null || distance(coordinate_params.position, lastCoordinate.data().position) > 50)
        {
          //Get coordinate ID if available
          coordinate_id = (coordinate_params.id ? coordinate_params.id : moment(new Date()).format('YYYY_MM_DD_hh_mm_ss_SSS'));
          
          //Log data
          logger.debug("Requesting reverse geocoding", coordinate_params.position);

          //Geocode address
          geocoder.reverse({
            lat: coordinate_params.position.latitude, 
            lon: coordinate_params.position.longitude
          })
          .then(function(res) 
          {
            //Save geocoding result (textual address)
            coordinate_params.address = res[0].formattedAddress;

            //Insert coordinates with geocoded address
            db.collection('Tracker/' + tracker_id + "/Coordinates")
              .doc(coordinate_id)
              .set(coordinate_params)
            
            //Send notification to users subscribed on this topic
            sendNotification(tracker_id, "NotifyMovement", {
              title: "Alerta de movimentação",
              content: res[0].formattedAddress,
              coordinates: coordinate_params.position.latitude + "," + coordinate_params.position.longitude,
              datetime: Date.now().toString()
            });

            //Log info
            logger.info('Successfully parsed location message from: ' + trackers[tracker_id].name + " - Coordinate inserted");
          })
          .catch(function(err) 
          {  
            //Error geocoding address
            coordinate_params.address = "Endereço próximo à coordenada não disponível."

            //Insert coordinates without geocoded address
            db.collection('Tracker/' + tracker_id + "/Coordinates")
              .doc(coordinate_id)
              .set(coordinate_params)

            //Send notification to users subscribed on this topic
            sendNotification(tracker_id, "NotifyMovement", {
              title: "Alerta de movimentação",
              content: "Coordenadas: " + coordinates.latitude + "," + coordinates.longitude,
              coordinates: coordinate_params.position.latitude + "," + coordinate_params.position.longitude,
              datetime: Date.now().toString()
            });

            //Log warning
            logger.warn('Parsed ' + type + ' location message from: ' + trackers[tracker_id].name + " - Geocoding failed: " + err);
          }); 
        }
        else
        {
          //Save current date time (updating last coordinate)
          coordinate_params.lastDatetime = coordinate_params.datetime;

          //Remove datetime from params to preserve initial coordinate datetime
          delete coordinate_params.datetime;

          //Current coordinates is too close from previous, just update last coordinate
          db.collection('Tracker/' + tracker_id + "/Coordinates")
            .doc(lastCoordinate.id)
            .update(coordinate_params);

          //Send notification to users subscribed on this topic
          sendNotification(tracker_id, "NotifyStopped", {
            title: "Alerta de permanência",
            content: "Rastreador permanece na mesma posição.",
            coordinates: coordinate_params.position.latitude + "," + coordinate_params.position.longitude,
            datetime: Date.now().toString()
          });
          
          //Log info
          logger.info('Successfully parsed location message from: ' + trackers[tracker_id].name + " - Coordinate updated");
        }
      })
      .catch(function(error) 
      {
        //Log error
        logger.error("Error getting document: ", error);
      });

    })
}

function formatPhoneNumber(number)
{
  //Remove country digit indicator
  number = number.replace('+','');
  
  //Remove BR international code (if exists)
  if(number.startsWith('55'))
    number = number.replace('55', '');

  //Remove leading 0 (if exists)
  if(number.startsWith('0'))
    number = number.replace('0','');

  //Return formated number
  return number;
}