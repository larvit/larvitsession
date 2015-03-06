'use strict';

var log         = require('winston'),
    db          = require('larvitdb'),
    uuidLib     = require('uuid'),
    cookieName  = 'session';

// Create database table if not exsists on first instance!!!


// Do not forget to remove the oldest session records

// Validate client uuid, only create server side

function session(request, response, callback) {
	var sessionKey,
	    sessionData = {},
	    err;

	if (request.cookies === undefined || response.cookies === undefined) {
		err = new Error('larvitsession: session() - can not find required cookies object on request or response object. Please load https://github.com/pillarjs/cookies into request.cookies');
		log.warn(err.message);
		callback(err);
		return;
	}

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
		var sql,
		    dbFields;

		log.silly('larvitsession: session() - getSession() - Running');

		// If sessionKey is not yet defined, try to get it from the cookies
		if (sessionKey === undefined) {
			log.silly('larvitsession: session() - getSession() - No sessionKey found, trying to get one');

			sessionKey = request.cookies.get(cookieName);

			log.silly('larvitsession: session() - getSession() - sessionKey loaded from cookie: "' + sessionKey + '"');

			// If the cookies did not know of the session key either, create a new one!
			if (sessionKey === undefined) {
				log.silly('larvitsession: session() - getSession() - sessionKey is undefined, run setNewSessionKey()');

				setNewSessionKey(function(err) {
					callback(err);
				});
			} else {
				log.silly('larvitsession: session() - getSession() - A session key was found, validate it and load from database');

				sql      = 'SELECT json FROM sessions WHERE uuid = ?';
				dbFields = [sessionKey];

				db.query(sql, dbFields, function(err, rows) {
					if (err) {
						callback(err);
						return;
					}

					if (rows.length === 0) {
						log.info('larvitsession: session() - getSession() - Invalid sessionKey supplied!');

						setNewSessionKey(function(err) {
							callback(err);
						});
					} else {

						// Database information found, load them  up
						try {
							sessionData = JSON.parse(rows[0].json);
							callback();
						} catch(err) {
							log.error('larvitsession: session() - getSession() - Invalid session data found in database! uuid: "' + sessionKey + '"');
							callback(err);
							return;
						}
					}
				});
			}
		} else {
			callback();
		}
	}

	/**
	 * Write session data to database via REPLACE
	 *
	 * @param func callback(err)
	 */
	function writeToDb(callback) {
		var sql = 'REPLACE INTO sessions (uuid, json) VALUES(?,?)',
		    dbFields;

		try {
			dbFields = [sessionKey, JSON.stringify(sessionData)];
		} catch(err) {
			err.message = 'larvitsession: setSessionData() - ' + err.message;

			log.error(err.message);
		}

		db.query(sql, dbFields, function(err) {
			if (err) {
				callback(err);
				return;
			}

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
	request.session.destroy = function destroySession(callback) {
		var sql = 'DELETE FROM sessions WHERE uuid = ?',
		    dbFields;

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
	request.session.get = function getSessionData(key, callback) {
		getSession(function(err) {
			if (err) {
				callback(err);
				return;
			}

			if (sessionData === undefined) {
				callback(null);
				return;
			}

			if (key === undefined) {
				callback(null, sessionData);
				return;
			}

			callback(null, sessionData[key]);
		});
	};

	/**
	 * Remove session data
	 *
	 * @param str key - can be omitted to remove all session data
	 * @param func callback(err)
	 */
	request.session.rm = function rmSessionData(key, callback) {
		getSession(function(err) {
			if (err) {
				callback(err);
				return;
			}

			delete sessionData[key];

			writeToDb(function(err) {
				callback(err);
			});
		});
	};

	/**
	 * Set session data for given key
	 *
	 * @param str key
	 * @param mixed value - serializeable json
	 * @param func callback(err)
	 */
	request.session.set = function setSessionData(key, value, callback) {
		if (typeof callback !== 'function') {
			callback = function() {
				log.silly('larvitsession: session() - request.session.get() - no valid callback sent');
			};
		}

		getSession(function(err) {
			if (err) {
				callback(err);
				return;
			}

			sessionData[key] = value;

			writeToDb(function(err) {
				callback(err);
			});
		});
	};

	callback();
}

exports.middleware = function() {
	return function(request, response, callback) {
		session(request, response, callback);
	};
};