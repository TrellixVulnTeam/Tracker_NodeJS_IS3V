//Imports package used to create a TCP server
var net = require('net');

//Import logger
const logger = require('../logs/logger');

//Import event emiter class
const EventEmitter = require('events');

//Define methods and properties
class TCP_Parser extends EventEmitter
{
    constructor (server_name, tcp_port)
    {
        //Call parent constructor
        super();

        //Initialize server
        this._server = net.createServer();
        this._server_name = server_name;
        this._connections = {};
        this._tcp_port = tcp_port;

        //Initialize server
        this.initialize();
    }

    initialize()
    {
        //Define actions on new TCP connection
        this._server.on('connection', conn => 
        {
            //Log connection
            logger.info('TCP (' +  conn.remoteAddress + ") -> Connected");

            //Set enconding
            conn.setEncoding('utf8');

            //On receive data from TCP connection
            conn.on('data', data => 
            {
                //Log data received
                logger.debug("TCP (" + conn.remoteAddress + ') -> [' + data.replace(/\r?\n|\r/, '') + ']');

                //Check if this is COBAN GPRS protocol
                if(data.startsWith('##'))
                {
                    //Split data using ';' separator
                    var content = data.split(',');

                    //Call method to handle tcp data
                    this.emit('data', 'TK102B', conn,
                    { 
                        source: content[1].trim(), 
                        content: content
                    });
                }
                else if(data.includes("ST910"))
                {
                    //Split data using ';' separator
                    var content = data.split(';');

                    //Call method to handle tcp data
                    this.emit('data', 'ST910', conn,
                    { 
                        source: (content[1] == 'RES' ? content[3].trim() : content[2].trim()), 
                        content: content
                    });
                }
                else if(data.length > 5)
                {
                    //Log warning
                    logger.warn("Unknown data structure received from TCP connection");
                }

            });

            //On TCP connection close
            conn.on('close', function () {
            
                //Log info
                logger.info('TCP (' +  conn.remoteAddress + ") -> Disconnected");
            });

            //On TCP connection error
            conn.on('error', err => {

                //Log error
                logger.error('TCP (' +  conn.remoteAddress + ") -> Error: " + err.message);
            });
        });

         //Set error handler
         this._server.on("error", error =>
         {
            //Log error
            logger.error('Error opening TCP port: ' + this._tcp_port + " / Error: " + error);
         });

         //Start listening for TCP connections
         this._server.listen(this._tcp_port, () => {  

            //Log info
            logger.info('TCP server listening to port: ' +  this._tcp_port);
         });
        
    }
    
}

module.exports = TCP_Parser