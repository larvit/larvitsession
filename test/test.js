'use strict';

const freeport = require('freeport');
const Session  = require('../index.js');
const request  = require('request').defaults({'jar': true});
const assert   = require('assert');
const LUtils   = require('larvitutils');
const lUtils   = new LUtils();
const uuid     = require('uuid');
const App      = require('larvitbase');
const log      = new lUtils.Log('warn');
const fs       = require('fs');
const db       = require('larvitdb');

before(function (done) {
	/* eslint-disable require-jsdoc */
	function checkEmptyDb() {
		db.query('SHOW TABLES', function (err, rows) {
			if (err) throw err;

			if (rows.length) {
				log.error('Database is not empty. To make a test, you must supply an empty database!');
				assert.deepEqual(rows.length, 0);
				process.exit(1);
			}

			done();
		});
	}

	function runDbSetup(confFile) {
		const conf = require(confFile);

		conf.log = log;
		log.verbose('larvitsession: DB config file: "' + confFile + '"');
		log.verbose('larvitsession: DB config: ' + conf);

		db.setup(conf, function (err) {
			if (err) throw err;

			db.removeAllTables(function (err) {
				if (err) throw err;

				checkEmptyDb();
			});
		});
	}
	/* eslint-enable require-jsdoc */

	if (fs.existsSync(__dirname + '/../config/db_test.json')) {
		runDbSetup('../config/db_test.json');
	} else if (process.env.DB_CONF_FILE && fs.existsSync(process.cwd() + '/' + process.env.DB_CONF_FILE)) {
		runDbSetup(process.cwd() + '/' + process.env.DB_CONF_FILE);
	} else {
		throw new Error('No database configuration found');
	}
});

after(function (done) {
	// We set a timeout here, since the server will fiddle with the database a bit after the response have been sent
	setTimeout(function () {
		db.removeAllTables(function (err) {
			if (err) throw err;
			done();
			process.exit();
		});
	}, 1000);
});

const createWebServer = (session, cb) => {
	if (typeof session === 'function') {
		cb = session;
		session = new Session({'db': db, 'log': log});
	}

	let httpPort;
	let app;

	freeport(function (err, port) {
		if (err) throw err;

		httpPort = port;

		app = new App({
			'log':         log,
			'httpOptions': port,
			'middlewares': [function (req, res, cb) {
				if (JSON.stringify(req.session.data) === '{}') {
					req.session.data = 'hej test test';
				} else {
					assert.strictEqual(req.session.data, 'hej test test');
				}

				res.end('gordon');

				cb();
			}]
		});

		app.middlewares.unshift(function (req, res, cb) { session.start(req, res, cb); });
		app.middlewares.unshift(require('cookies').express());
		app.middlewares.push(function (req, res, cb) { session.writeToDb(req, res, cb); });

		app.start(function (err) {
			if (err) throw err;

			return cb({app, 'port': httpPort});
		});
	});
};

describe('Basics', function () {
	it('Setup http server', function (done) {
		createWebServer(context => {
			request('http://localhost:' + context.port, function (err) {
				if (err) throw err;
				request('http://localhost:' + context.port, function (err, response, body) {
					if (err) throw err;
					assert.strictEqual(body, 'gordon');
					done();
				});
			});
		});
	});

	it('Testing if sessions table got created', function (done) {
		createWebServer(context => {
			request('http://localhost:' + context.port, function (err) {
				if (err) throw err;
				db.query('SELECT * FROM sessions', function (err, result) {
					if (err) throw err;

					assert.strictEqual(JSON.parse(result[0].json), 'hej test test');

					request('http://localhost:' + context.port, function (err) {
						if (err) throw err;
						done(); // At least we know the sessions table have been created....
					});
				});
			});
		});
	});

	it('Creates a session cookie in the response with proper attributes', function (done) {
		const session = new Session({'db': db, 'log': log, 'cookieSameSite': 'none', 'cookieSecure': false});
		const jar = request.jar();

		createWebServer(session, context => {
			request('http://localhost:' + context.port, { jar }, function (err, res) {
				if (err) throw err;

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

				const session = cookieValues.session;
				const path = cookieValues.path;
				const httpOnly = cookieValues.httponly;
				const sameSite = cookieValues.samesite;
				const secure = cookieValues.secure;

				assert.ok(uuid.validate(session));
				assert.strictEqual(path, '/');
				assert.strictEqual(httpOnly, true);
				assert.strictEqual(sameSite, 'none');
				assert.strictEqual(secure, undefined);

				done();
			});
		});
	});

	it('Having session set to something that is not in db should result in new session value in response', function (done) {
		const jar = request.jar();
		const requestSessionUuid = uuid.v4();
		const headers = {
			'Cookie': `session=${requestSessionUuid}`
		};

		createWebServer(context => {
			request('http://localhost:' + context.port, { headers, jar }, function (err, res) {
				if (err) throw err;

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

				done();
			});
		});
	});
});

describe('With sessionExpire set to 30 days', function () {
	const sessionExpire = 30;
	const expireSession  = new Session({'db': db, 'log': log, 'sessionExpire': sessionExpire});

	it('Check that the session cookie expires in 30 days', function (done) {
		createWebServer(expireSession, context => {
			request('http://localhost:' + context.port, function (err, response) {
				if (err) throw err;

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

				done();
			});
		});
	});
});
