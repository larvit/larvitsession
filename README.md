[![Build Status](https://travis-ci.org/larvit/larvitsession.svg?branch=master)](https://travis-ci.org/larvit/larvitsession) [![Dependencies](https://david-dm.org/larvit/larvitsession.svg)](https://david-dm.org/larvit/larvitsession.svg)

# larvitsession

Session handling middleware

## Install

```javascript
npm i larvitsession
```

## Usage

The given example sets up larvitsession as a middleware to larvitbase. At the moment a database access is required via larvitdb.

```javascript
const lsession = require('larvitsession'),
      db       = require('larvitdb');

let conf;

db.setup({
	"connectionLimit":   10,
	"socketPath":        "/var/run/mysqld/mysqld.sock",
	"user":              "foo",
	"password":          "bar",
	"charset":           "utf8mb4_general_ci",
	"supportBigNumbers": true,
	"database":          "dbname"
});

conf = {
	"port": 8001,
	"host": "127.0.0.1",
	"pubFilePath": "./public"
};

conf.middleware = [
	require('cookies').express(),
	lsession.middleware() // Important that this is ran after the cookie middleware
];
conf.afterware = [
	lsession.afterware()
]

require('larvitbase')(conf);
```

Now in a controller we can use the session like this:

```javascript
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
```
