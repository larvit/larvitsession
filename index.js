'use strict';

const { Log } = require('larvitutils');
const { DbMigration } = require('larvitdbmigration');
const uuidLib = require('uuid');

const topLogPrefix = 'larvitsession: index.js - ';
const cookieName = 'session';

class Session {

	/**
	 *
	 * @param {obj} options {
	 * 'db': instance of db object
	 * 'deleteLimit': limit number of delete during cleanup of old sessions
	 * 'deleteKeepDays': number of days to keep during cleanup of old sessions
	 * 'deleteOnWrite': boolean that tells if old sessions should be deleted on write, defaults to true.
	 * 'sessionExpire': number of days to keep the session cookie alive. Expire will be set to 'session' if undefined
	 * 'cookieSameSite': string that sets the SameSite session cookie option, defaults to not being set at all (browser will default). 'strict', 'lax', 'none', 'false' or 'true' (maps to strict).
	 * 'cookieSecure': boolean that sets the secure session cookie option. Defaults to false for http and true for https if not set.
	 *
	 * // Optional
	 * 'log': instance of log object
	 * }
	 */
	constructor(options) {
		// istanbul ignore if
		if (!options.db) {
			throw new Error('Required options "db" is missing');
		}

		// istanbul ignore next
		this.log = options.log || new Log();
		this.db = options.db;
		this.deleteLimit = options.deleteLimit || 100;
		this.deleteKeepDays = options.deleteKeepDays || 10;
		this.deleteOnWrite = options.deleteOnWrite === undefined ? true : options.deleteOnWrite;
		this.sessionExpire = options.sessionExpire;
		this.cookieSameSite = options.cookieSameSite;
		this.cookieSecure = options.cookieSecure;
	}

	async runDbMigrations() {
		const options = {};
		options.dbType = 'mariadb';
		options.dbDriver = this.db;
		options.tableName = 'sessions_db_version';
		options.migrationScriptPath = __dirname + '/dbmigration';
		options.log = this.log;
		const dbMigration = new DbMigration(options);

		await dbMigration.run();
	}

	setSessionCookie(key, req) {
		const cookieOptions = {
			sameSite: this.cookieSameSite,
			secure: this.cookieSecure,
			overwrite: true,
		};

		if (this.sessionExpire) {
			const d = new Date();

			d.setTime(d.getTime() + (this.sessionExpire * 24 * 60 * 60 * 1000));
			cookieOptions['expires'] = d;
		}

		req.cookies.set(cookieName, key, cookieOptions);
	}

	async start(req, res, cb) {
		const logPrefix = topLogPrefix + 'start() - ';

		const cookieOptions = {
			sameSite: this.cookieSameSite,
			secure: this.cookieSecure,
			overwrite: true,
		};

		if (this.sessionExpire) {
			const d = new Date();

			d.setTime(d.getTime() + (this.sessionExpire * 24 * 60 * 60 * 1000));
			cookieOptions['expires'] = d;
		}

		/**
		 * Get session key and data from cookie and database or create new if it was missing either in cookie or database
		 * Will set the sessionKey in the outer scope
		 *
		 */
		const getSession = async () => {
			const subLogPrefix = logPrefix + 'getSession() - ';
			const dbFields = [];
			const sql = 'SELECT json FROM sessions WHERE uuid = ?';

			this.log.silly(subLogPrefix + 'Running');

			// If sessionKey is not yet defined, try to get it from the cookies
			if (req.session.key === undefined) {
				this.log.silly(subLogPrefix + 'No sessionKey found, trying to get one');

				req.session.key = req.cookies.get(cookieName);

				if (!uuidLib.validate(req.session.key)) {
					delete req.session.key;
				}

				this.log.silly(subLogPrefix + 'sessionKey loaded from cookie: "' + req.session.key + '"');
			}

			// If the cookies did not know of the session key either, create a new one!
			if (req.session.key === undefined) {
				this.log.silly(subLogPrefix + 'sessionKey is undefined, set a new, random uuid');

				req.session.key = uuidLib.v4();
				req.cookies.set(cookieName, req.session.key, cookieOptions);

				return;
			}

			req.cookies.set(cookieName, req.session.key, cookieOptions);

			this.log.silly(subLogPrefix + 'A session key was found, validate it and load from database');

			dbFields.push(req.session.key);

			const { rows } = await this.db.query(sql, dbFields);

			if (rows.length === 0) {
				// This might be OK since it might have been cleared on an earlier call. Good to log, but no need to scream. :)
				this.log.verbose(subLogPrefix + 'No session data found for key with uuid: "' + req.session.key + '"');

				// Always set a new, random uuid to make sure no one manually sets their own session uuid to spoof the system
				req.session.key = uuidLib.v4();
				req.cookies.set(cookieName, req.session.key, cookieOptions);

				return;
			}

			req.session.startData = String(rows[0].json);

			// Database information found, load them  up
			try {
				req.session.data = JSON.parse(rows[0].json);
			} catch (err) /* istanbul ignore next */ {
				this.log.error(subLogPrefix + 'Invalid session data found in database! uuid: "' + req.session.key + '"');
				throw err;
			}

			this.log.debug(subLogPrefix + 'Fetched data from database: ' + rows[0].json);
		};

		// Initiate req.session
		req.session = {data: {}};

		// istanbul ignore if
		if (req.cookies === undefined || res.cookies === undefined) {
			const err = new Error('Can not find required cookies object on req or res object. Please load https://github.com/pillarjs/cookies into req.cookies');
			this.log.error(logPrefix + err.message);

			return cb(err);
		}

		/**
		 * Destroy session - remove data from database and delete session cookie
		 */
		req.session.destroy = async () => {
			const dbFields = [];
			const sql = 'DELETE FROM sessions WHERE uuid = ?';

			req.session.key = req.cookies.get(cookieName);

			// istanbul ignore if
			if (req.session.key === undefined || !uuidLib.validate(req.session.key)) {
				req.session = {data: {}};

				return;
			}

			dbFields.push(req.session.key);

			await this.db.query(sql, dbFields);
			// Remove the cookie
			// "If the value is omitted, an outbound header with an expired date is used to delete the cookie."
			req.cookies.set(cookieName);
			req.session = {data: {}};
		};

		try {
			await getSession();
		} catch (err) /* istanbul ignore next */ {
			return cb(err);
		}

		cb();
	};

	async writeToDb(req, res, cb) {
		const logPrefix = topLogPrefix + 'writeToDb() - ';
		const dbFields = [];
		const sql = 'INSERT INTO sessions (uuid, json) VALUES(?,?) ON DUPLICATE KEY UPDATE json = VALUES(json)';

		try {
			dbFields.push(req.session.key);
			dbFields.push(JSON.stringify(req.session.data));
		} catch (err) /* istanbul ignore next */ {
			this.log.error(logPrefix + err.message);

			return cb(err);
		}

		if (dbFields[1] === '{}') {
			this.log.debug(logPrefix + 'Empty session data, remove completely from database not to waste space');
			await this.db.query('DELETE FROM sessions WHERE uuid = ?', [req.session.key]);

			return cb();
		} else if (!uuidLib.validate(req.session.key)) /* istanbul ignore next */ {
			const err = new Error('Invalid session key');

			this.log.info(logPrefix + err.message);

			return cb(err);
		}

		if (dbFields[1] === req.session.startData) {
			this.log.debug(logPrefix + 'Session data is not different from database, do not rewrite it');

			return cb();
		}

		try {
			await this.db.query(sql, dbFields);
			cb();
		} catch (err) /* istanbul ignore next */ {
			return cb(err);
		}

		if (this.deleteOnWrite) {
			this.deleteOldSessions();
		}
	};

	async deleteOldSessions() {
		const logPrefix = topLogPrefix + 'deleteOldSessions() -';

		let sql = `DELETE FROM sessions WHERE updated < DATE_SUB(NOW(), INTERVAL ${this.deleteKeepDays} DAY)`;

		if (this.deleteLimit) {
			sql += ` LIMIT ${this.deleteLimit}`;
		}

		sql += ';';

		this.log.debug(`${logPrefix} Deleting old sessions, deleteKeepDays: ${this.deleteKeepDays}, deleteLimit: ${this.deleteLimit}`);

		const {rows} = await this.db.query(sql);
		this.log.verbose(`${logPrefix} ${rows.affectedRows} old session(s) deleted`);
	};

	async loadSession(key, req) {
		const logPrefix = topLogPrefix + 'loadSession() - ';
		const sql = 'SELECT json FROM sessions WHERE uuid = ?';

		const { rows } = await this.db.query(sql, [key]);

		if (!rows.length) {
			this.log.verbose(logPrefix + 'No session data found for key with uuid: "' + key + '"');

			return false;
		}

		const sessionDataStr = rows[0].json;
		req.session.key = key;
		req.session.startData = sessionDataStr;
		req.session.data = JSON.parse(sessionDataStr);

		this.setSessionCookie(key, req);

		this.log.debug(`${logPrefix}Loaded session "${key}" from database: ${sessionDataStr}`);

		return true;
	}
}

exports = module.exports = Session;
