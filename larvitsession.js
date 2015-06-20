'use strict';

var log         = require('winston'),
    db          = require('larvitdb'),
    uuidLib     = require('uuid'),
    cookieName  = 'session',
    dbCreated   = false;

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
			dbCreated = true;
		}
	});
})();

function session(request, response, callback) {
	var err;

	// Initiate request.session
	request.session = {'data': {}};

	if (request.cookies === undefined || response.cookies === undefined) {
		err = new Error('Can not find required cookies object on request or response object. Please load https://github.com/pillarjs/cookies into request.cookies');
		log.warn('larvitsession: session() - ' + err.message);
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

		request.sessionKey = uuidLib.v4();
		dbFields           = [request.sessionKey, JSON.stringify({})];

		response.cookies.set(cookieName, request.sessionKey);

		db.query(sql, dbFields, function(err) {
			if (err) {
				callback(err);
				return;
			}

			log.debug('larvitsession: session() - getSession() - New sessionKey created and saved in database');

			request.startSessionData = false; // Set this to make sure to always write the new session data
			request.session.data     = {};

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

		if (dbCreated === false) {
			log.verbose('larvitsession: session() - getSession() - Database table is not yet created, postponing execution of this function.');

			setTimeout(function() {
				getSession(callback);
			}, 10);

			return;
		}

		log.silly('larvitsession: session() - getSession() - Running');

		// If sessionKey is not yet defined, try to get it from the cookies
		if (request.sessionKey === undefined) {
			log.silly('larvitsession: session() - getSession() - No sessionKey found, trying to get one');

			request.sessionKey = request.cookies.get(cookieName);

			log.silly('larvitsession: session() - getSession() - sessionKey loaded from cookie: "' + request.sessionKey + '"');
		}

		// If the cookies did not know of the session key either, create a new one!
		if (request.sessionKey === undefined) {
			log.silly('larvitsession: session() - getSession() - sessionKey is undefined, run setNewSessionKey()');

			setNewSessionKey(callback);
		} else {
			log.silly('larvitsession: session() - getSession() - A session key was found, validate it and load from database');

			dbFields = [request.sessionKey];

			db.query(sql, dbFields, function(err, rows) {
				if (err) {
					callback(err);
					return;
				}

				if (rows.length === 0) {
					log.info('larvitsession: session() - getSession() - Invalid sessionKey supplied!');

					setNewSessionKey(callback);
				} else {

					request.startSessionData = rows[0].json;

					// Database information found, load them  up
					try {
						request.session.data = JSON.parse(rows[0].json);
					} catch(err) {
						log.error('larvitsession: session() - getSession() - Invalid session data found in database! uuid: "' + request.sessionKey + '"');
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

		request.sessionKey = request.cookies.get(cookieName);

		if (request.sessionKey === undefined) {
			callback();
			return;
		}

		dbFields = [request.sessionKey];

		db.query(sql, dbFields, function(err) {
			if (err) {
				callback(err);
				return;
			}

			// Remove the cookie
			// "If the value is omitted, an outbound header with an expired date is used to delete the cookie."
			request.cookies.set(cookieName);
			request.sessionKey = undefined;
			callback();
		});
	};

	// Load session by default
	getSession(callback);
}

function writeToDb(request, response, data, callback) {
	var sql = 'REPLACE INTO sessions (uuid, json) VALUES(?,?)',
	    dbFields;

	try {
		dbFields = [request.sessionKey, JSON.stringify(request.session.data)];
	} catch(err) {
		log.error('larvitsession: session() - writeToDb() - ' + err.message);
		callback(err, request, response, data);
		return;
	}

	if (dbFields[1] === request.startSessionData) {
		log.debug('larvitsession: larvitsession: session() - writeToDb() - session data is not different from database, do not rewrite it');
		callback(null, request, response, data);
		return;
	}

	db.query(sql, dbFields, function(err) {
		callback(err, request, response, data);

		// Clean up old entries
		db.query('DELETE FROM sessions WHERE updated < DATE_SUB(NOW(), INTERVAL 10 DAY);');
	});
}

exports.middleware = function() {
	return session;
};

exports.afterware = function() {
	return writeToDb;
};