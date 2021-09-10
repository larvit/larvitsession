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
const session  = new Session({'db': db, 'log': log});

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

describe('Basics', function () {
	let httpPort;
	let app;

	it('Setup http server', function (done) {
		freeport(function (err, port) {
			let found = false;

			if (err) throw err;

			httpPort = port;

			app = new App({
				'log':         log,
				'httpOptions': port,
				'middlewares': [function (req, res, cb) {
					if (JSON.stringify(req.session.data) === '{}') {
						req.session.data = 'hej test test';
					} else {
						found	= true;
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
				request('http://localhost:' + port, function (err) {
					if (err) throw err;
					request('http://localhost:' + port, function (err, response, body) {
						if (err) throw err;
						assert.strictEqual(body, 'gordon');
						assert.strictEqual(found, true);
						done();
					});
				});
			});
		});
	});

	it('Testing if sessions table got created', function (done) {
		request('http://localhost:' + httpPort, function (err) {
			if (err) throw err;
			db.query('SELECT * FROM sessions', function (err, result) {
				if (err) throw err;

				assert.strictEqual(JSON.parse(result[0].json), 'hej test test');

				request('http://localhost:' + httpPort, function (err) {
					if (err) throw err;
					done(); // At least we know the sessions table have been created....
				});
			});
		});
	});

	it('Creates a session cookie in the response with proper attributes', function (done) {
		const jar = request.jar();

		request('http://localhost:' + httpPort, { jar }, function (err, res) {
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

			assert.strictEqual(Object.keys(cookieValues).length, 3);

			const session = cookieValues.session;
			const path = cookieValues.path;
			const httpOnly = cookieValues.httponly;

			assert.ok(uuid.validate(session));
			assert.strictEqual(path, '/');
			assert.strictEqual(httpOnly, true);

			done();
		});
	});
});

describe('With sessionExpire set to 30 days', function () {
	const sessionExpire = 30;
	const expireSession  = new Session({'db': db, 'log': log, 'sessionExpire': sessionExpire});

	let httpPort;
	let app;

	it('Setup http server', function (done) {
		freeport(function (err, port) {
			let found = false;

			if (err) throw err;

			httpPort = port;

			app = new App({
				'log':         log,
				'httpOptions': port,
				'middlewares': [function (req, res, cb) {
					if (JSON.stringify(req.session.data) === '{}') {
						req.session.data = 'hej test test';
					} else {
						found	= true;
						assert.strictEqual(req.session.data, 'hej test test');
					}

					res.end('gordon');

					cb();
				}]
			});

			app.middlewares.unshift(function (req, res, cb) { expireSession.start(req, res, cb); });
			app.middlewares.unshift(require('cookies').express());
			app.middlewares.push(function (req, res, cb) { expireSession.writeToDb(req, res, cb); });

			app.start(function (err) {
				if (err) throw err;
				request('http://localhost:' + port, function (err) {
					if (err) throw err;
					request('http://localhost:' + port, function (err, response, body) {
						if (err) throw err;
						assert.strictEqual(body, 'gordon');
						assert.strictEqual(found, true);
						done();
					});
				});
			});
		});
	});

	it('Check that the session cookie expires in 30 days', function (done) {
		request('http://localhost:' + httpPort, function (err, response) {
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
