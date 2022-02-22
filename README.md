[![Build Status](https://github.com/larvit/larvitsession/actions/workflows/actions.yml/badge.svg)](https://github.com/larvit/larvitsession/actions)

# larvitsession

Session handling middleware

## Usage

The given example sets up larvitsession as a middleware to larvitbase. At the moment a database access is required via larvitdb.

```javascript
const Session = require('larvitsession');
const winston = require('winston');
const log = winston.createLogger({transports: [new winston.transports.Console()]});
const App = require('larvitbase');
const Db = require('larvitdb');

let session;
let conf;
let app;

const db = new Db({
	connectionLimit:   10,
	socketPath:        "/var/run/mysqld/mysqld.sock",
	user:              "foo",
	password:          "bar",
	charset:           "utf8mb4_general_ci",
	supportBigNumbers: true,
	database:          "dbname"
});

session = new Session({
	db:  db,
	log: log
});

// Create the app with a single middleware to view a page on port 8001
app = new App({
	httpOptions: 8001,
	middlewares: [function (req, res, cb) {
		if (req.session.data.counter === undefined) {
			res.session.data.counter = 1;
		} else {
			req.session.data.counter ++;
		}
		res.write('Your browsersession have viewed this page ' + req.session.data.counter + ' time(s)');
		cb();
	}]
});

// Add the session middlewares
// This way of adding the session middlewares works well on larvitbase-www as well, when there are many middlewares
app.middlewares.unshift(session.start);
app.middlewares.unshift(request('cookies').express());
app.middlewares.push(session.writeToDb);

app.run(function (err) {
	if (err) throw err;
});
```

# Changelog
## 6.0.0
- Upped lib versions
- Replaced callbacks with promises (not for the start/writeToDb middlewares)