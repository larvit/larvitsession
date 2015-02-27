'use strict';

var log         = require('winston'),
    uuidLib     = require('uuid'),
    cookieName  = 'session',
    sessionData = {};

function session(request, response, callback) {
	var sessionKey,
	    err;

	if (request.cookies === undefined || response.cookies === undefined) {
		err = new Error('larvitsession: middleware() - can not find required cookies object on request or response object. Please load https://github.com/pillarjs/cookies into request.cookies');
		log.warn(err.message);
		callback(err);
		return;
	}

	function getSetSessionKey() {
		// If sessionKey is not yet defined, try to get it from the cookies
		if (sessionKey === undefined) {
			sessionKey = request.cookies.get(cookieName);

			// If the cookies did not know of the session key either, create a new one!
			if (sessionKey === undefined) {
				sessionKey = uuidLib.v1();
				response.cookies.set(cookieName, sessionKey);
			}
		}
	}

	function getSessionData(key) {
		getSetSessionKey();

		if (sessionData[sessionKey] === undefined) {
			return undefined;
		}

		if (key === undefined) {
			return sessionData[sessionKey];
		}

		return sessionData[sessionKey][key];
	}

	function setSessionData(key, value) {
		getSetSessionKey();

		if (sessionData[sessionKey] === undefined) {
			sessionData[sessionKey] = {};
		}

		sessionData[sessionKey][key] = value;
	}

	request.session = response.session = {
		'set': setSessionData,
		'get': getSessionData
	};

	callback();
}

exports.middleware = function() {
	return function(request, response, callback) {
		session(request, response, callback);
	};
};