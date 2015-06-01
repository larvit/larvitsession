'use strict';

var log         = require('winston'),
    db          = require('larvitdb'),
    uuidLib     = require('uuid'),
    cookieName  = 'session';

(function createDb() {
	var sql = 'CREATE TABLE IF NOT EXISTS `sessions` (' +
	          '  `uuid` char(36) COLLATE ascii_general_ci NOT NULL,' +
	          '  `json` varchar(15000) COLLATE utf8mb4_unicode_ci NOT NULL,' +
	          '  `updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,' +
	          '  PRIMARY KEY (`uuid`),' +
	          '  KEY `updated` (`updated`)' +
	          ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;';

	db.query(sql, function(err) {
		if (err) {
			log.error('larvitsession: Could not create database table: ' + err.message);
		} else {
			log.verbose('larvitsession: sessions table created if it did not exist');
		}
	});
})();

function session(request, response, callback) {
	var sessionKey,
	    startSessionData,
	    sessionData,
	    err;

	if (request.cookies === undefined || response.cookies === undefined) {
		err = new Error('Can not find required cookies object on request or response object. Please load https://github.com/pillarjs/cookies into request.cookies');
		log.warn('larvitsession: session() - ' + err.message);
		callback(err);
		return;
	}

	// Wirte to database on response finnish or close
	response.on('finish', function() {
		log.verbose('larvitsession: session() - response.on(finish) triggered!');
		writeToDb();
	});
	response.on('close', function() {
		log.verbose('larvitsession: session() - response.on(close) triggered!');
		writeToDb();
	});

	/**
	 * Set new session key
	 * Will create a new random sessionKey (uuid) and store it to database, cookie and local variable "sessionKey"
	 *
	 * @param func callback(err)
	 */
	function setNewSessionKey(callback) {
		var sql = 'INSERT INTO sessions (uuid, json) VALUES(?,?)',
		    dbFields;

		sessionKey = uuidLib.v4();
		dbFields   = [sessionKey, JSON.stringify({})];

		response.cookies.set(cookieName, sessionKey);

		db.query(sql, dbFields, function(err) {
			if (err) {
				callback(err);
				return;
			}

			log.debug('larvitsession: session() - getSession() - New sessionKey created and saved in database');

			startSessionData = false; // Set this to make sure to always write the new session data
			sessionData      = {};

			callback();
		});
	}

	/**
	 * Get session key and data from cookie and database or create new if it was missing either in cookie or database
	 * Will set the sessionKey in the outer scope
	 *
	 * @param callback(err)
	 */
	function getSession(callback) {
		var sql = 'SELECT json FROM sessions WHERE uuid = ?',
		    dbFields;

		log.silly('larvitsession: session() - getSession() - Running');

		// If sessionKey is not yet defined, try to get it from the cookies
		if (sessionKey === undefined) {
			log.silly('larvitsession: session() - getSession() - No sessionKey found, trying to get one');

			sessionKey = request.cookies.get(cookieName);

			log.silly('larvitsession: session() - getSession() - sessionKey loaded from cookie: "' + sessionKey + '"');
		}

		// If the cookies did not know of the session key either, create a new one!
		if (sessionKey === undefined) {
			log.silly('larvitsession: session() - getSession() - sessionKey is undefined, run setNewSessionKey()');

			setNewSessionKey(callback);
		} else {
			log.silly('larvitsession: session() - getSession() - A session key was found, validate it and load from database');

			dbFields = [sessionKey];

			db.query(sql, dbFields, function(err, rows) {
				if (err) {
					callback(err);
					return;
				}

				if (rows.length === 0) {
					log.info('larvitsession: session() - getSession() - Invalid sessionKey supplied!');

					setNewSessionKey(callback);
				} else {

					startSessionData = rows[0].json;

					// Database information found, load them  up
					try {
						sessionData = JSON.parse(rows[0].json);
					} catch(err) {
						log.error('larvitsession: session() - getSession() - Invalid session data found in database! uuid: "' + sessionKey + '"');
						callback(err);
						return;
					}

					log.debug('larvitsession: session() - getSession() - Fetched data from database: "' + rows[0].json);

					callback();
				}
			});
		}
	}

	/**
	 * Get local session data
	 *
	 * @param str key - can be omitted to get all session data
	 * @param func callback(err, value)
	 */
	function getSessionData(key, callback) {
		var err;

		if (sessionData === undefined) {
			err = new Error('sessionData is undefined');
			log.warn('larvitsession: session() - getSessionData() - ' + err.message);
			callback(err);
			return;
		}

		if (key === undefined) {
			callback(null, sessionData);
			return;
		}

		callback(null, sessionData[key]);
	}

	/**
	 * Write session data to database via REPLACE
	 *
	 * @param func callback(err)
	 */
	function writeToDb(callback) {
		var sql = 'REPLACE INTO sessions (uuid, json) VALUES(?,?)',
		    dbFields;

		if (typeof callback !== 'function') {
			callback = function() {};
		}

		try {
			dbFields = [sessionKey, JSON.stringify(sessionData)];
		} catch(err) {
			err.message = 'larvitsession: session() - writeToDb() - ' + err.message;

			log.error(err.message);
		}

		if (dbFields[1] === startSessionData) {
			log.debug('larvitsession: larvitsession: session() - writeToDb() - session data is not different from database, do not rewrite it');
			callback();
			return;
		}

		db.query(sql, dbFields, function(err) {
			if (err) {
				callback(err);
				return;
			}

			// Clean up old entries
			db.query('DELETE FROM sessions WHERE updated < DATE_SUB(NOW(), INTERVAL 10 DAY);');

			callback();
		});
	}

	// Initiate request.session
	request.session = {};

	/**
	 * Destroy session - remove data from database and delete session cookie
	 *
	 * @param func callback(err)
	 */
	request.session.destroy = function(callback) {
		var sql = 'DELETE FROM sessions WHERE uuid = ?',
		    dbFields;

		if (typeof callback !== 'function') {
			callback = function() {};
		}

		sessionKey = request.cookies.get(cookieName);

		if (sessionKey === undefined) {
			callback();
			return;
		}

		dbFields = [sessionKey];

		db.query(sql, dbFields, function(err) {
			if (err) {
				callback(err);
				return;
			}

			// Remove the cookie
			// "If the value is omitted, an outbound header with an expired date is used to delete the cookie."
			request.cookies.set(cookieName);
			sessionKey = undefined;
			callback();
		});
	};

	/**
	 * Get session data
	 *
	 * @param str key - can be omitted to get all session data
	 * @param func callback(err, value)
	 */
	request.session.get = function(key, callback) {
		if (sessionData !== undefined) {
			getSessionData(key, callback);
			return;
		}

		getSession(function(err) {
			if (err) {
				callback(err);
				return;
			}

			getSessionData(key, callback);
		});
	};

	/**
	 * Remove session data
	 *
	 * @param str key - can be omitted to remove all session data
	 * @param func callback(err)
	 */
	request.session.rm = function(key, callback) {
		if (typeof callback !== 'function') {
			callback = function() {};
		}

		getSession(function(err) {
			if (err) {
				callback(err);
				return;
			}

			delete sessionData[key];
		});
	};

	/**
	 * Set session data for given key
	 *
	 * @param str key
	 * @param mixed value - serializeable json
	 * @param func callback(err)
	 */
	request.session.set = function(key, value, callback) {
		if (typeof callback !== 'function') {
			callback = function() {
				log.silly('larvitsession: session() - request.session.set() - no valid callback sent');
			};
		}

		getSession(function(err) {
			if (err) {
				callback(err);
				return;
			}

			log.silly('larvitsession: session() - request.session.set() - Setting "' + key + '" to "' + value + '"');
			sessionData[key] = value;
			callback();
		});
	};

	callback();
}

exports.middleware = function() {
	return function(request, response, callback) {
		session(request, response, callback);
	};
};