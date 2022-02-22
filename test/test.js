'use strict';

const { CookieJar } = require('tough-cookie');
const { DateTime } = require('luxon');
const { Log } = require('larvitutils');
const { wrapper } = require('axios-cookiejar-support');
const App = require('larvitbase');
const assert = require('assert');
const async = require('async');
const axios = require('axios').default;
const Db = require('larvitdb');
const freeport = require('freeport');
const fs = require('fs');
const path = require('path');
const Session = require('../index');
const uuid = require('uuid');

const log = new Log('verbose');
let db;

function getSessionKeyFromResponse(res) {
	const cookieStr = res.headers['set-cookie'][0];
	const cookieValues = cookieStr
		.split(';')
		.map(keyValueStr => keyValueStr.split('='))
		.reduce((result, keyValueArr) => {
			result[keyValueArr[0].trim()] = keyValueArr[1] || true;

			return result;
		}, {});

	return cookieValues.session;
}

before(async () => {
	wrapper(axios);

	function runDbSetup(confFile) {
		log.verbose('larvitsession: DB config file: "' + confFile + '"');

		const conf = require(confFile);
		log.verbose('larvitsession: DB config: ' + JSON.stringify(conf, undefined, 2));

		conf.log = log;

		db = new Db(conf);
	}

	if (fs.existsSync(path.join(__dirname, '/../config/db_test.json'))) {
		runDbSetup(path.join(__dirname, '/../config/db_test.json'));
	} else if (process.env.DB_CONF_FILE && fs.existsSync(process.cwd() + '/' + process.env.DB_CONF_FILE)) {
		runDbSetup(process.cwd() + '/' + process.env.DB_CONF_FILE);
	} else {
		throw new Error('No database configuration found');
	}
});

after(async () => {
	await db.removeAllTables();
});

const createWebServer = async options => {
	log.verbose('Creating test web server');

	await db.removeAllTables();

	options = options || {};
	options.session = options.session || new Session({db, log});

	await options.session.runDbMigrations();

	options.sessionData = options.sessionData || 'hej test test';

	let httpPort;
	let app;

	return new Promise((res, rej) => {
		freeport(function (err, port) {
			if (err) return rej(err);

			httpPort = port;

			app = new App({
				log: log,
				httpOptions: port,
				middlewares: [function (req, res, cb) {
					req.session.data = typeof options.sessionData === 'function'
						? options.sessionData()
						: options.sessionData;

					res.end('gordon');

					cb();
				}],
			});

			// Override default if middleware is provided
			if (options.middleware) app.middlewares = [options.middleware];

			app.middlewares.unshift(function (req, res, cb) { options.session.start(req, res, cb); });
			app.middlewares.unshift(require('cookies').express());
			app.middlewares.push(function (req, res, cb) { options.session.writeToDb(req, res, cb); });

			app.start(function (err) {
				if (err) return rej(err);

				return res({app, port: httpPort});
			});
		});
	});
};

describe('Basics', () => {
	it('Setup http server', async () => {
		const context = await createWebServer();
		const response = await axios('http://localhost:' + context.port);
		assert.strictEqual(response.data, 'gordon');
	});

	it('Testing if sessions table got created', async () => {
		const context = await createWebServer();
		await axios('http://localhost:' + context.port);

		const { rows } = await db.query('SELECT * FROM sessions');
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(JSON.parse(rows[0].json), 'hej test test');
	});

	it('Should update session data', async () => {
		const jar = new CookieJar();
		const session = new Session({db: db, log: log});
		let testSessionData = 'first data';
		let sessionUuid = '';

		function sessionData() {
			return testSessionData;
		}

		const context = await createWebServer({ session, sessionData });

		// Create session
		const res = await axios('http://localhost:' + context.port, {jar});
		sessionUuid = getSessionKeyFromResponse(res);

		// Verify db
		const { rows } = await db.query('SELECT * FROM sessions WHERE uuid = ?;', [sessionUuid]);
		assert.strictEqual(JSON.parse(rows[0].json), 'first data');

		// Update session with new data
		testSessionData = 'updated data';
		await axios('http://localhost:' + context.port, {jar});

		// Verify that session is updated in db
		const { rows: rowsAfterUpdate } = await db.query('SELECT * FROM sessions WHERE uuid = ?', [sessionUuid]);
		assert.strictEqual(JSON.parse(rowsAfterUpdate[0].json), 'updated data');
	});

	it('Session data should be loaded into req object', async () => {
		const jar = new CookieJar();
		const session = new Session({db: db, log: log});

		// First the middleware should store some session data
		let middleware = (req, res, cb) => {
			req.session.data = 'session data value';
			res.end();
			cb();
		};

		const context = await createWebServer({ session, middleware: (req, res, cb) => middleware(req, res, cb) });

		// Create session
		await axios('http://localhost:' + context.port, {jar});

		// Now middleware should verify that the session data is loaded
		let loadedSessionData = '';
		middleware = (req, res, cb) => {
			loadedSessionData = req.session.data;
			res.end();
			cb();
		};

		await axios('http://localhost:' + context.port, {jar});

		assert.strictEqual(loadedSessionData, 'session data value');
	});

	it('Should remove old sessions on demand', async () => {
		const session = new Session({db: db, log: log, deleteKeepDays: 1, deleteOnWrite: false});
		let testSessionData = 'remove on demand test data';

		function sessionData() {
			return testSessionData;
		}

		const context = await createWebServer({ session, sessionData });
		// Create session
		await axios('http://localhost:' + context.port);
		const { rows } = await db.query('SELECT * FROM sessions WHERE json = \'"remove on demand test data"\'');
		assert.strictEqual(JSON.parse(rows[0].json), 'remove on demand test data');

		// Hack to make a session old
		const expiredDate = DateTime
			.utc()
			.minus({days: 2})
			.toISODate();

		let expireSessionSql = `UPDATE sessions SET updated = '${expiredDate}'
								WHERE json = '"remove on demand test data"'`;

		await db.query(expireSessionSql);

		// Delete old sessions
		await session.deleteOldSessions();

		// Verify that session is deleted
		const { rows: rowsAfterDelete } = await db.query('SELECT * FROM sessions WHERE json = \'"remove on demand test data"\'');
		assert.strictEqual(rowsAfterDelete.length, 0);
	});

	it('Should remove old sessions on write', async () => {
		const session = new Session({db: db, log: log, deleteKeepDays: 1});
		let testSessionData = 'remove on delete data';

		function sessionData() {
			return testSessionData;
		}

		const context = await createWebServer({ session, sessionData });

		// Create session
		await axios('http://localhost:' + context.port);
		const { rows } = await db.query('SELECT * FROM sessions WHERE json = \'"remove on delete data"\'');
		assert.strictEqual(JSON.parse(rows[0].json), 'remove on delete data');

		// Hack to make a session old
		const expiredDate = DateTime
			.utc()
			.minus({days: 2})
			.toISODate();

		let expireSessionSql = `UPDATE sessions SET updated = '${expiredDate}'
								WHERE json = '"remove on delete data"'`;

		await db.query(expireSessionSql);

		// Delete old sessions on next write (another session)
		testSessionData = 'another session that should delete the first one';
		await axios('http://localhost:' + context.port);

		// Verify that session is deleted (deletion is async so can take a while)
		await async.retry({ times: 100, interval: 100 }, async () => {
			const { rows } = await db.query('SELECT * FROM sessions WHERE json = \'"remove on delete data"\'');
			if (rows.length !== 0) {
				throw new Error('Session has not been removed');
			}
		});
	});

	it('Creates a session cookie in the response with proper attributes', async () => {
		const session = new Session({db: db, log: log, cookieSameSite: 'none', cookieSecure: false});

		const context = await createWebServer({ session });
		const res = await axios('http://localhost:' + context.port);
		assert.ok(res.headers['set-cookie']);
		assert.strictEqual(res.headers['set-cookie'].length, 1);

		const cookieStr = res.headers['set-cookie'][0];
		const cookieValues = cookieStr
			.split(';')
			.map(keyValueStr => keyValueStr.split('='))
			.reduce((result, keyValueArr) => {
				result[keyValueArr[0].trim()] = keyValueArr[1] || true;

				return result;
			}, {});

		console.log(`Cookie: ${cookieStr}`);

		assert.strictEqual(Object.keys(cookieValues).length, 4);

		const sessionUuid = cookieValues.session;
		const path = cookieValues.path;
		const httpOnly = cookieValues.httponly;
		const sameSite = cookieValues.samesite;
		const secure = cookieValues.secure;

		assert.ok(uuid.validate(sessionUuid));
		assert.strictEqual(path, '/');
		assert.strictEqual(httpOnly, true);
		assert.strictEqual(sameSite, 'none');
		assert.strictEqual(secure, undefined);
	});

	it('Having session set to something that is not in db should result in new session value in response', async () => {
		const requestSessionUuid = uuid.v4();
		const headers = {
			Cookie: `session=${requestSessionUuid}`,
		};

		const context = await createWebServer();

		const res = await axios('http://localhost:' + context.port, { headers });
		assert.ok(res.headers['set-cookie']);
		assert.strictEqual(res.headers['set-cookie'].length, 1);

		const cookieStr = res.headers['set-cookie'][0];
		const cookieValues = cookieStr
			.split(';')
			.map(keyValueStr => keyValueStr.split('='))
			.reduce((result, keyValueArr) => {
				result[keyValueArr[0].trim()] = keyValueArr[1] || true;

				return result;
			}, {});

		console.log(`Cookie: ${cookieStr}`);

		assert.strictEqual(Object.keys(cookieValues).length, 3);

		const session = cookieValues.session;

		assert.ok(uuid.validate(session));
		assert.notStrictEqual(uuid, requestSessionUuid);
	});

	it('should destroy session and not load data to req object on next request', async () => {
		const jar = new CookieJar();
		const session = new Session({db: db, log: log});

		// First the middleware should store some session data
		let middleware = (req, res, cb) => {
			req.session.data = 'session data value';
			res.end();
			cb();
		};

		const context = await createWebServer({ session, middleware: (req, res, cb) => middleware(req, res, cb) });

		// Create session
		await axios('http://localhost:' + context.port, {jar});

		// Destroy session
		middleware = async (req, res, cb) => {
			await req.session.destroy();
			res.end();
			cb();
		};

		await axios('http://localhost:' + context.port, {jar});

		// Verify that session has been destroyed
		let loadedSessionData = '';
		middleware = (req, res, cb) => {
			loadedSessionData = req.session.data;
			res.end();
			cb();
		};

		await axios('http://localhost:' + context.port, {jar});

		assert.deepStrictEqual(loadedSessionData, {});
	});

	it('should save the same session data twice (should be optimized to not db write second time)', async () => {
		const jar = new CookieJar();
		const session = new Session({db: db, log: log});

		// Middleware that stores some session data
		let middleware = (req, res, cb) => {
			req.session.data = { asdf: 'session data value' };
			res.end();
			cb();
		};

		const context = await createWebServer({ session, middleware: (req, res, cb) => middleware(req, res, cb) });

		// Create session
		await axios('http://localhost:' + context.port, {jar});

		// Write same data again
		await axios('http://localhost:' + context.port, {jar});

		// Verify session data
		let loadedSessionData = '';
		middleware = (req, res, cb) => {
			loadedSessionData = req.session.data;
			res.end();
			cb();
		};

		await axios('http://localhost:' + context.port, {jar});

		assert.deepStrictEqual(loadedSessionData, { asdf: 'session data value' });
	});
});

describe('With sessionExpire set to 30 days', () => {
	it('Check that the session cookie expires in 30 days', async () => {
		const sessionExpire = 30;
		const expireSession = new Session({db, log, sessionExpire: sessionExpire});
		const context = await createWebServer({ session: expireSession });
		const response = await axios('http://localhost:' + context.port);
		const cookie = response.headers['set-cookie'][0];
		const splitCookie = cookie.split(';');

		for (const sc of splitCookie) {
			if (sc.trim().startsWith('expires')) {
				const expires = sc.replace('expires=', '').trim();
				const dateExpires = new Date(expires);
				const dateNow = new Date();
				const difference = dateExpires.getTime() - dateNow.getTime();
				const days = Math.ceil(difference / (1000 * 3600 * 24));

				assert.strictEqual(days, sessionExpire);
			}
		}
	});
});
