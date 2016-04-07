'use strict';

const freeport = require('freeport'),
      request  = require('request').defaults({jar: true}),
      cookies  = require('cookies'),
      assert   = require('assert'),
      lbase    = require('larvitbase'),
      log      = require('winston'),
      fs       = require('fs'),
      db       = require('larvitdb');

// Set up winston
log.remove(log.transports.Console);
log.add(log.transports.Console, {
	'level':     'warn',
	'colorize':  true,
	'timestamp': true,
	'json':      false
});

before(function(done) {
	let confFile;

	function checkEmptyDb() {
		db.query('SHOW TABLES', function(err, rows) {
			if (err) {
				log.error(err);
				assert( ! err, 'err should be negative');
				process.exit(1);
			}

			if (rows.length) {
				log.error('Database is not empty. To make a test, you must supply an empty database!');
				assert.deepEqual(rows.length, 0);
				process.exit(1);
			}

			done();
		});
	}

	function runDbSetup(confFile) {
		log.verbose('DB config: ' + JSON.stringify(require(confFile)));

		db.setup(require(confFile), function(err) {
			assert( ! err, 'err should be negative');

			checkEmptyDb();
		});
	}

	if (process.argv[3] === undefined)
		confFile = __dirname + '/../config/db_test.json';
	else
		confFile = process.argv[3].split('=')[1];

	log.verbose('DB config file: "' + confFile + '"');

	fs.stat(confFile, function(err) {
		const altConfFile = __dirname + '/../config/' + confFile;

		if (err) {
			log.info('Failed to find config file "' + confFile + '", retrying with "' + altConfFile + '"');

			fs.stat(altConfFile, function(err) {
				if (err)
					assert( ! err, 'fs.stat failed: ' + err.message);

				if ( ! err) {
					runDbSetup(altConfFile);
				}
			});
		} else {
			runDbSetup(confFile);
		}
	});
});

after(function(done) {
	// We set a timeout here, since the server will fiddle with the database a bit after the response have been sent
	setTimeout(function() {
		db.removeAllTables(done);
	}, 100);
});

describe('Basics', function() {
	let httpPort;

	it('Setup http server', function(done) {
		const lsession = require(__dirname + '/../larvitsession.js');

		freeport(function(err, port) {
			const conf = {};

			if (err) {
				throw err;
			}

			conf.port = httpPort = port;
			conf.middleware = [
				cookies.express(),
				lsession.middleware()
			];
			conf.afterware = [
				lsession.afterware()
			];

			lbase(conf);
			done();
		});
	});

	it('yo', function(done) {
		request('http://localhost:' + httpPort, function(err) {
			assert( ! err, 'err should be negative');

			db.query('SELECT * FROM sessions', function(err) {
				assert( ! err, 'err should be negative');

				done(); // At least we know the sessions table have been created....
			});
		});

	});
});