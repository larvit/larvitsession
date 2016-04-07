'use strict';

const dbMigration = require('larvitdbmigration'),
      cookieName  = 'session',
      uuidLib     = require('uuid'),
      log         = require('winston'),
      db          = require('larvitdb');

let dbCreated = false;

dbMigration({'tableName': 'sessions_db_version'})(function(err) {
	if (err) {
		log.error('larvitsession: Could not run database migrations: ' + err.message);
	} else {
		log.verbose('larvitsession: Database migrations ran successfully');
		dbCreated = true;
	}
});

db.ready(function() {
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
});

function session(req, res, cb) {
	var err;

	// Initiate req.session
	req.session = {'data': {}};

	if (req.cookies === undefined || res.cookies === undefined) {
		err = new Error('Can not find required cookies object on req or res object. Please load https://github.com/pillarjs/cookies into req.cookies');
		log.warn('larvitsession: session() - ' + err.message);
		cb(err);
		return;
	}

	/**
	 * Set new session key
	 * Will create a new random sessionKey (uuid) and store it to database, cookie and local variable "sessionKey"
	 *
	 * @param func cb(err)
	 */
	function setNewSessionKey(cb) {
		var sql = 'INSERT INTO sessions (uuid, json) VALUES(?,?)',
		    dbFields;

		req.sessionKey = uuidLib.v4();
		dbFields       = [req.sessionKey, JSON.stringify({})];

		res.cookies.set(cookieName, req.sessionKey);

		db.query(sql, dbFields, function(err) {
			if (err) {
				cb(err);
				return;
			}

			log.debug('larvitsession: session() - getSession() - New sessionKey created and saved in database');

			req.startSessionData = false; // Set this to make sure to always write the new session data
			req.session.data     = {};

			cb();
		});
	}

	/**
	 * Get session key and data from cookie and database or create new if it was missing either in cookie or database
	 * Will set the sessionKey in the outer scope
	 *
	 * @param cb(err)
	 */
	function getSession(cb) {
		var sql = 'SELECT json FROM sessions WHERE uuid = ?',
		    dbFields;

		if (dbCreated === false) {
			log.verbose('larvitsession: session() - getSession() - Database table is not yet created, postponing execution of this function.');

			setTimeout(function() {
				getSession(cb);
			}, 10);

			return;
		}

		log.silly('larvitsession: session() - getSession() - Running');

		// If sessionKey is not yet defined, try to get it from the cookies
		if (req.sessionKey === undefined) {
			log.silly('larvitsession: session() - getSession() - No sessionKey found, trying to get one');

			req.sessionKey = req.cookies.get(cookieName);

			log.silly('larvitsession: session() - getSession() - sessionKey loaded from cookie: "' + req.sessionKey + '"');
		}

		// If the cookies did not know of the session key either, create a new one!
		if (req.sessionKey === undefined) {
			log.silly('larvitsession: session() - getSession() - sessionKey is undefined, run setNewSessionKey()');

			setNewSessionKey(cb);
		} else {
			log.silly('larvitsession: session() - getSession() - A session key was found, validate it and load from database');

			dbFields = [req.sessionKey];

			db.query(sql, dbFields, function(err, rows) {
				if (err) {
					cb(err);
					return;
				}

				if (rows.length === 0) {
					// This might be OK since it might have been cleared on an earlier call. Good to log, but no need to scream. :)
					log.verbose('larvitsession: session() - getSession() - Invalid sessionKey supplied!');

					setNewSessionKey(cb);
				} else {

					req.startSessionData = rows[0].json;

					// Database information found, load them  up
					try {
						req.session.data = JSON.parse(rows[0].json);
					} catch(err) {
						log.error('larvitsession: session() - getSession() - Invalid session data found in database! uuid: "' + req.sessionKey + '"');
						cb(err);
						return;
					}

					log.debug('larvitsession: session() - getSession() - Fetched data from database: "' + rows[0].json);

					cb();
				}
			});
		}
	}

	/**
	 * Destroy session - remove data from database and delete session cookie
	 *
	 * @param func cb(err)
	 */
	req.session.destroy = function(cb) {
		var sql = 'DELETE FROM sessions WHERE uuid = ?',
		    dbFields;

		if (typeof cb !== 'function') {
			cb = function() {};
		}

		req.sessionKey = req.cookies.get(cookieName);

		if (req.sessionKey === undefined) {
			cb();
			return;
		}

		dbFields = [req.sessionKey];

		db.query(sql, dbFields, function(err) {
			if (err) {
				cb(err);
				return;
			}

			// Remove the cookie
			// "If the value is omitted, an outbound header with an expired date is used to delete the cookie."
			req.cookies.set(cookieName);
			req.sessionKey = undefined;
			cb();
		});
	};

	// Load session by default
	getSession(cb);
}

function writeToDb(req, res, data, cb) {
	var sql = 'REPLACE INTO sessions (uuid, json) VALUES(?,?)',
	    dbFields;

	try {
		dbFields = [req.sessionKey, JSON.stringify(req.session.data)];
	} catch(err) {
		log.error('larvitsession: writeToDb() - ' + err.message);
		cb(err, req, res, data);
		return;
	}

	if (dbFields[1] === '{}') {
		log.debug('larvitsession: writeToDb() - Empty session data, remove completely from database not to waste space');
		db.query('DELETE FROM sessions WHERE uuid = ?', [req.sessionKey], cb);
		return;
	}

	if (dbFields[1] === req.startSessionData) {
		log.debug('larvitsession: writeToDb() - Session data is not different from database, do not rewrite it');
		cb(null, req, res, data);
		return;
	}

	db.query(sql, dbFields, function(err) {
		cb(err, req, res, data);

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