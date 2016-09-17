'use strict';

const	dbMigration	= require('larvitdbmigration'),
	cookieName	= 'session',
	uuidLib	= require('uuid'),
	Events	= require('events'),
	log	= require('winston'),
	db	= require('larvitdb'),
	dbCreateEmitter	= new Events();

let dbCreated = false;

dbMigration({'tableName': 'sessions_db_version', 'migrationScriptsPath': __dirname + '/dbmigration'})(function(err) {
	if (err) {
		log.error('larvitsession: Could not run database migrations: ' + err.message);
	} else {
		log.verbose('larvitsession: Database migrations ran successfully');
		dbCreated = true;
		dbCreateEmitter.emit('created');
	}
});

function ready(cb) {
	if (dbCreated === true) {
		cb();
		return;
	}

	dbCreateEmitter.on('created', cb);
}

function session(req, res, cb) {
	// Initiate req.session
	req.session = {'data': {}};

	if (req.cookies === undefined || res.cookies === undefined) {
		let err = new Error('Can not find required cookies object on req or res object. Please load https://github.com/pillarjs/cookies into req.cookies');
		log.warn('larvitsession: session() - ' + err.message);
		cb(err);
		return;
	}

	/**
	 * Get session key and data from cookie and database or create new if it was missing either in cookie or database
	 * Will set the sessionKey in the outer scope
	 *
	 * @param cb(err)
	 */
	function getSession(cb) {
		const	dbFields	= [],
			sql	= 'SELECT json FROM sessions WHERE uuid = ?';

		ready(function() {
			log.silly('larvitsession: session() - getSession() - Running');

			// If sessionKey is not yet defined, try to get it from the cookies
			if (req.session.key === undefined) {
				log.silly('larvitsession: session() - getSession() - No sessionKey found, trying to get one');

				req.session.key = req.cookies.get(cookieName);

				log.silly('larvitsession: session() - getSession() - sessionKey loaded from cookie: "' + req.session.key + '"');
			}

			// If the cookies did not know of the session key either, create a new one!
			if (req.session.key === undefined) {
				log.silly('larvitsession: session() - getSession() - sessionKey is undefined, set a new, random uuid');

				req.session.key = uuidLib.v4();
				req.cookies.set(cookieName, req.session.key);
				cb();
				return;
			}

			log.silly('larvitsession: session() - getSession() - A session key was found, validate it and load from database');

			dbFields.push(req.session.key);

			db.query(sql, dbFields, function(err, rows) {
				if (err) { cb(err); return; }

				if (rows.length === 0) {
					// This might be OK since it might have been cleared on an earlier call. Good to log, but no need to scream. :)
					log.verbose('larvitsession: session() - getSession() - No session data found for key with uuid: "' + req.session.key + '"');

					// Always set a new, random uuid to make sure no one manually sets their own session uuid to spoof the system
					req.session.key = uuidLib.v4();
					req.cookies.set(cookieName, req.session.key);
					cb();
					return;
				}

				req.session.startData = rows[0].json;

				// Database information found, load them  up
				try {
					req.session.data = JSON.parse(rows[0].json);
				} catch(err) {
					log.error('larvitsession: session() - getSession() - Invalid session data found in database! uuid: "' + req.session.key + '"');
					cb(err);
					return;
				}

				log.debug('larvitsession: session() - getSession() - Fetched data from database: "' + rows[0].json);

				cb();
			});
		});
	}

	/**
	 * Destroy session - remove data from database and delete session cookie
	 *
	 * @param func cb(err)
	 */
	req.session.destroy = function(cb) {
		const	dbFields	= [],
			sql	= 'DELETE FROM sessions WHERE uuid = ?';

		if (typeof cb !== 'function') {
			cb = function() {};
		}

		req.session.key = req.cookies.get(cookieName);

		if (req.session.key === undefined) {
			req.session = {'data': {}};
			cb();
			return;
		}

		dbFields.push(req.session.key);

		ready(function() {
			db.query(sql, dbFields, function(err) {
				if (err) { cb(err); return; }

				// Remove the cookie
				// "If the value is omitted, an outbound header with an expired date is used to delete the cookie."
				req.cookies.set(cookieName);
				req.session = {'data': {}};

				cb();
			});
		});
	};

	// Load session by default
	getSession(cb);
}

function writeToDb(req, res, data, cb) {
	const	dbFields	= [],
		sql	= 'REPLACE INTO sessions (uuid, json) VALUES(?,?)';

	try {
		dbFields.push(req.session.key);
		dbFields.push(JSON.stringify(req.session.data));
	} catch(err) {
		log.error('larvitsession: writeToDb() - ' + err.message);
		cb(err, req, res, data);
		return;
	}

	ready(function() {
		if (dbFields[1] === '{}') {
			log.debug('larvitsession: writeToDb() - Empty session data, remove completely from database not to waste space');
			db.query('DELETE FROM sessions WHERE uuid = ?', [req.session.key], cb);
			return;
		}

		if (dbFields[1] === req.session.startData) {
			log.debug('larvitsession: writeToDb() - Session data is not different from database, do not rewrite it');
			cb(null, req, res, data);
			return;
		}

		db.query(sql, dbFields, function(err) {
			cb(err, req, res, data);

			// Clean up old entries
			db.query('DELETE FROM sessions WHERE updated < DATE_SUB(NOW(), INTERVAL 10 DAY);');
		});
	});
}

exports.middleware = function() {
	return session;
};

exports.afterware = function() {
	return writeToDb;
};
