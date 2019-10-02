'use strict';

const topLogPrefix = 'larvitsession: index.js - ';
const DbMigration  = require('larvitdbmigration');
const cookieName   = 'session';
const validate     = require('uuid-validate');
const uuidLib      = require('uuid');
const LUtils       = require('larvitutils');
const Events       = require('events');

/**
 *
 * @param {obj} options {
 * 	'db': instance of db object
 * 	'deleteLimit': limit number of delete during cleanup of old sessions
 * 	'deleteKeepDays': number of days to keep during cleanup of old sessions
 *
 * // Optional
 * 	'log': instance of log object
 * }
 */
function Session(options) {
	const that = this;

	that.options      = options || {};
	that.eventEmitter = new Events();

	if (! that.options.log) {
		const lUtils = new LUtils();

		that.options.log = new lUtils.Log();
	}

	if (! options.db) {
		throw new Error('Required options "db" is missing');
	}

	that.log = that.options.log;
	that.db  = that.options.db;
	that.deleteLimit = options.deleteLimit || 100;
	that.deleteKeepDays = options.deleteKeepDays || 10;
}

Session.prototype.ready = function ready(cb) {
	const logPrefix = topLogPrefix + 'ready() - ';
	const options   = {};
	const that      = this;

	let dbMigration;

	if (typeof cb !== 'function') {
		cb = function () {};
	}
	if (that.isReady === true) return cb();

	if (that.readyInProgress === true) {
		that.eventEmitter.on('ready', cb);

		return;
	}

	that.readyInProgress = true;

	that.log.debug(logPrefix + 'Waiting for dbmigration()');

	options.dbType               = 'mariadb';
	options.dbDriver             = that.db;
	options.tableName            = 'sessions_db_version';
	options.migrationScriptsPath = __dirname + '/dbmigration';
	options.log                  = that.log;
	dbMigration                  = new DbMigration(options);

	dbMigration.run(function (err) {
		if (err) {
			that.log.error(topLogPrefix + err.message);

			return;
		}

		that.isReady         = true;
		that.readyInProgress = false;
		that.eventEmitter.emit('ready');

		cb(err);
	});
};

Session.prototype.start = function start(req, res, cb) {
	const logPrefix = topLogPrefix + 'start() - ';
	const that      = this;

	/**
	 * Get session key and data from cookie and database or create new if it was missing either in cookie or database
	 * Will set the sessionKey in the outer scope
	 *
	 * @param {func} cb(err)
	 * @returns {func} self
	 */
	function getSession(cb) {
		const subLogPrefix = logPrefix + 'getSession() - ';
		const dbFields     = [];
		const sql          = 'SELECT json FROM sessions WHERE uuid = ?';

		that.log.silly(subLogPrefix + 'Running');

		// If sessionKey is not yet defined, try to get it from the cookies
		if (req.session.key === undefined) {
			that.log.silly(subLogPrefix + 'No sessionKey found, trying to get one');

			req.session.key = req.cookies.get(cookieName);

			if (! validate(req.session.key, 4)) {
				delete req.session.key;
			}

			that.log.silly(subLogPrefix + 'sessionKey loaded from cookie: "' + req.session.key + '"');
		}

		// If the cookies did not know of the session key either, create a new one!
		if (req.session.key === undefined) {
			that.log.silly(subLogPrefix + 'sessionKey is undefined, set a new, random uuid');

			req.session.key	= uuidLib.v4();
			req.cookies.set(cookieName, req.session.key);

			return cb();
		}

		that.log.silly(subLogPrefix + 'A session key was found, validate it and load from database');

		dbFields.push(req.session.key);

		that.db.query(sql, dbFields, function (err, rows) {
			if (err) return cb(err);

			if (rows.length === 0) {
				// This might be OK since it might have been cleared on an earlier call. Good to log, but no need to scream. :)
				that.log.verbose(subLogPrefix + 'No session data found for key with uuid: "' + req.session.key + '"');

				// Always set a new, random uuid to make sure no one manually sets their own session uuid to spoof the system
				req.session.key = uuidLib.v4();
				req.cookies.set(cookieName, req.session.key);

				return cb();
			}

			req.session.startData	= rows[0].json;

			// Database information found, load them  up
			try {
				req.session.data	= JSON.parse(rows[0].json);
			} catch (err) {
				that.log.error(subLogPrefix + 'Invalid session data found in database! uuid: "' + req.session.key + '"');

				return cb(err);
			}

			that.log.debug(subLogPrefix + 'Fetched data from database: ' + rows[0].json);

			cb();
		});
	}

	// Initiate req.session
	req.session = {'data': {}};

	if (req.cookies === undefined || res.cookies === undefined) {
		const	err	= new Error('Can not find required cookies object on req or res object. Please load https://github.com/pillarjs/cookies into req.cookies');

		that.log.error(logPrefix + err.message);

		return cb(err);
	}

	/**
	 * Destroy session - remove data from database and delete session cookie
	 *
	 * @param {func} cb(err)
	 * @returns {func} cb
	 */
	req.session.destroy = function destroy(cb) {
		const dbFields = [];
		const sql      = 'DELETE FROM sessions WHERE uuid = ?';

		if (typeof cb !== 'function') {
			cb = function () {};
		}

		req.session.key	= req.cookies.get(cookieName);

		if (req.session.key === undefined || ! validate(req.session.key, 4)) {
			req.session = {'data': {}};

			return cb();
		}

		dbFields.push(req.session.key);

		that.db.query(sql, dbFields, function (err) {
			if (err) return cb(err);

			// Remove the cookie
			// "If the value is omitted, an outbound header with an expired date is used to delete the cookie."
			req.cookies.set(cookieName);
			req.session = {'data': {}};

			cb();
		});
	};

	// Load session by default
	that.ready(function (err) {
		if (err) return cb(err);
		getSession(cb);
	});
};

Session.prototype.writeToDb = function writeToDb(req, res, cb) {
	const logPrefix = topLogPrefix + 'writeToDb() - ';
	const dbFields  = [];
	const that      = this;
	const sql       = 'REPLACE INTO sessions (uuid, json) VALUES(?,?)';

	try {
		dbFields.push(req.session.key);
		dbFields.push(JSON.stringify(req.session.data));
	} catch (err) {
		that.log.error(logPrefix + err.message);

		return cb(err);
	}

	that.ready(function (err) {
		if (err) return cb(err);

		if (dbFields[1] === '{}') {
			that.log.debug(logPrefix + 'Empty session data, remove completely from database not to waste space');
			that.db.query('DELETE FROM sessions WHERE uuid = ?', [req.session.key], cb);

			return;
		} else if (! validate(req.session.key, 4)) {
			const err = new Error('Invalid session key');

			that.log.info(logPrefix + err.message);

			return cb(err);
		}

		if (dbFields[1] === req.session.startData) {
			that.log.debug(logPrefix + 'Session data is not different from database, do not rewrite it');

			return cb();
		}

		that.db.query(sql, dbFields, function (err) {
			cb(err);

			// Clean up old entries
			let sql = `DELETE FROM sessions WHERE updated < DATE_SUB(NOW(), INTERVAL ${that.deleteKeepDays} DAY)`;

			if (that.deleteLimit) {
				sql += ` LIMIT ${that.deleteLimit}`;
			}

			sql += ';';

			that.db.query(sql);
		});
	});
};

exports = module.exports = Session;
