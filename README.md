# larvitsession

Session handling middleware

## Install

    npm i larvitsession

## Usage

The given example sets up larvitsession as a middleware to larvitbase. At the moment a database access is required via larvitdb.

    var db = require('larvitdb'),
        conf;

    db.setup({
    	"connectionLimit":   10,
    	"socketPath":        "/var/run/mysqld/mysqld.sock",
    	"user":              "foo",
    	"password":          "bar",
    	"charset":           "utf8mb4_general_ci",
    	"supportBigNumbers": true,
    	"database":          "dbname"
    });

    conf = {{
    	"port": 8001,
    	"host": "127.0.0.1",
    	"pubFilePath": "./public"
    };

    serverConf.middleware = [
    	require('cookies').express(),
    	require('larvitsession').middleware() // Important that this is ran after the cookie middleware
    ];

    require('larvitbase')(conf);

Now in a controller we can use the session like this:

    'use strict';

    exports.run = function(request, response, callback) {

    	// Destroy the session, so we're sure to start on a clean slate
    	request.session.destroy(function(err) {
    		if (err) {
    			throw err;
    		}

    		// Set a new key/value - this will be saved in database and can be retreived on page reload
    		request.session.data.foo = 'bar';
    	});
    };