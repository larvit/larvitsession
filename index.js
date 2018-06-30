'use strict';

const	topLogPrefix	= 'larvitsession: index.js - ',
	DbMigration	= require('larvitdbmigration'),
	cookieName	= 'session',
	uuidLib	= require('uuid'),
	validate	= require('uuid-validate'),
	Events	= require('events'),
	log	= require('winston'),
	db	= require('larvitdb'),
	eventEmitter	= new Events();

let	readyInProgress	= false,
	isReady	= false;

function ready(cb) {
	const	logPrefix	= topLogPrefix + 'ready() - ',
		options	= {};

	let	dbMigration;

	if (typeof cb !== 'function') {
		cb = function () {};
	}
	if (isReady === true) return cb();

	if (readyInProgress === true) {
		eventEmitter.on('ready', cb);
		return;
	}

	readyInProgress	= true;

	log.debug(logPrefix + 'Waiting for dbmigration()');

	options.dbType	= 'larvitdb';
	options.dbDriver	= db;
	options.tableName	= 'sessions_db_version';
	options.migrationScriptsPath	= __dirname + '/dbmigration';
	dbMigration	= new DbMigration(options);

	dbMigration.run(function (err) {
		if (err) {
			log.error(topLogPrefix + err.message);
			return;
		}

		isReady	= true;
		readyInProgress	= false;
		eventEmitter.emit('ready');

		cb(err);
	});
}

function start(req, res, cb) {
	const	logPrefix	= topLogPrefix + 'start() - ';

	/**
	 * Get session key and data from cookie and database or create new if it was missing either in cookie or database
	 * Will set the sessionKey in the outer scope
	 *
	 * @param cb(err)
	 */
	function getSession(cb) {
		const	subLogPrefix	= logPrefix + 'getSession() - ',
			dbFields	= [],
			sql	= 'SELECT json FROM sessions WHERE uuid = ?';

		log.silly(subLogPrefix + 'Running');

		// If sessionKey is not yet defined, try to get it from the cookies
		if (req.session.key === undefined) {
			log.silly(subLogPrefix + 'No sessionKey found, trying to get one');

			req.session.key	= req.cookies.get(cookieName);

			if ( ! validate(req.session.key, 4)) {
				delete req.session.key;
			}

			log.silly(subLogPrefix + 'sessionKey loaded from cookie: "' + req.session.key + '"');
		}

		// If the cookies did not know of the session key either, create a new one!
		if (req.session.key === undefined) {
			log.silly(subLogPrefix + 'sessionKey is undefined, set a new, random uuid');

			req.session.key	= uuidLib.v4();
			req.cookies.set(cookieName, req.session.key);
			return cb();
		}

		log.silly(subLogPrefix + 'A session key was found, validate it and load from database');

		dbFields.push(req.session.key);

		db.query(sql, dbFields, function (err, rows) {
			if (err) return cb(err);

			if (rows.length === 0) {
				// This might be OK since it might have been cleared on an earlier call. Good to log, but no need to scream. :)
				log.verbose(subLogPrefix + 'No session data found for key with uuid: "' + req.session.key + '"');

				// Always set a new, random uuid to make sure no one manually sets their own session uuid to spoof the system
				req.session.key	= uuidLib.v4();
				req.cookies.set(cookieName, req.session.key);
				return cb();
			}

			req.session.startData	= rows[0].json;

			// Database information found, load them  up
			try {
				req.session.data	= JSON.parse(rows[0].json);
			} catch (err) {
				log.error(subLogPrefix + 'Invalid session data found in database! uuid: "' + req.session.key + '"');
				return cb(err);
			}

			log.debug(subLogPrefix + 'Fetched data from database: "' + rows[0].json);

			cb();
		});
	}

	// Initiate req.session
	req.session = {'data': {}};

	if (req.cookies === undefined || res.cookies === undefined) {
		const	err	= new Error('Can not find required cookies object on req or res object. Please load https://github.com/pillarjs/cookies into req.cookies');
		log.error(logPrefix + err.message);
		return cb(err);
	}

	/**
	 * Destroy session - remove data from database and delete session cookie
	 *
	 * @param func cb(err)
	 */
	req.session.destroy = function destroy(cb) {
		const	dbFields	= [],
			sql	= 'DELETE FROM sessions WHERE uuid = ?';

		if (typeof cb !== 'function') {
			cb	= function () {};
		}

		req.session.key	= req.cookies.get(cookieName);

		if (req.session.key === undefined || ! validate(req.session.key, 4)) {
			req.session = {'data': {}};
			return cb();
		}

		dbFields.push(req.session.key);

		db.query(sql, dbFields, function (err) {
			if (err) return cb(err);

			// Remove the cookie
			// "If the value is omitted, an outbound header with an expired date is used to delete the cookie."
			req.cookies.set(cookieName);
			req.session	= {'data': {}};

			cb();
		});
	};

	// Load session by default
	ready(function (err) {
		if (err) return cb(err);
		getSession(cb);
	});
}

function writeToDb(req, res, cb) {
	const	logPrefix	= topLogPrefix + 'writeToDb() - ',
		dbFields	= [],
		sql	= 'REPLACE INTO sessions (uuid, json) VALUES(?,?)';

	try {
		dbFields.push(req.session.key);
		dbFields.push(JSON.stringify(req.session.data));
	} catch (err) {
		log.error(logPrefix + err.message);
		return cb(err);
	}

	ready(function (err) {
		if (err) return cb(err);

		if (dbFields[1] === '{}') {
			log.debug(logPrefix + 'Empty session data, remove completely from database not to waste space');
			db.query('DELETE FROM sessions WHERE uuid = ?', [req.session.key], cb);
			return;
		} else {
			if ( ! validate(req.session.key, 4)) {
				const	err	= new Error('Invalid session key');
				log.info(logPrefix + err.message);
				return cb(err);
			}
		}

		if (dbFields[1] === req.session.startData) {
			log.debug(logPrefix + 'Session data is not different from database, do not rewrite it');
			return cb();
		}

		db.query(sql, dbFields, function (err) {
			cb(err);

			// Clean up old entries
			db.query('DELETE FROM sessions WHERE updated < DATE_SUB(NOW(), INTERVAL 10 DAY);');
		});
	});
}

exports.start	= start;
exports.writeToDb	= writeToDb;
