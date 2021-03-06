"use strict";

var parser = require('./parser.js')()
  , logFactory = require('./logger.js')
  , logger = null
  , args = null
  , fs = require('fs')
  , path = require('path')
  , noPermsCheck = false;

require('colors');

process.chdir(path.resolve(__dirname, '../..'));

if (require.main === module) {
  args = parser.parseArgs();
  noPermsCheck = args.noPermsCheck;
  logFactory.init(args);
}

logger = logFactory.get('appium');

if (!noPermsCheck) {
  var appiumPermStat = fs.statSync(path.resolve(__dirname,
                                                '../../package.json'));
  var launchCmd = (process.env.SUDO_COMMAND || "").toLowerCase();
  var isWindows = require('appium-support').system.isWindows();

  if (
    !isWindows &&
    // Appium should be run by user who owns files in Appium installation directory
    appiumPermStat.uid !== process.getuid() &&
    // authorize* commands could be run using sudo
    !launchCmd.match(/authorize/)
  ) {
    logger.error("Appium will not work if used or installed with sudo. " +
                 "Please rerun/install as a non-root user. If you had to " +
                 "install Appium using `sudo npm install -g appium`, the " +
                 "solution is to reinstall Node using a method (Homebrew, " +
                 "for example) that doesn't require sudo to install global " +
                 "npm packages.");
    process.exit(1);
  }
}

var http = require('http')
  , express = require('express')
  , favicon = require('serve-favicon')
  , bodyParser = require('body-parser')
  , methodOverride = require('method-override')
  , morgan = require('morgan') // logger
  , routing = require('./routing.js')
  , path = require('path')
  , appium = require('../appium.js')
  , parserWrap = require('./middleware').parserWrap
  , appiumVer = require('../../package.json').version
  , appiumRev = null
  , async = require('async')
  , helpers = require('./helpers.js')
  , logFinalWarning = require('../helpers.js').logFinalDeprecationWarning
  , getConfig = require('../helpers.js').getAppiumConfig
  , allowCrossDomain = helpers.allowCrossDomain
  , catchAllHandler = helpers.catchAllHandler
  , checkArgs = helpers.checkArgs
  , configureServer = helpers.configureServer
  , startListening = helpers.startListening
  , conditionallyPreLaunch = helpers.conditionallyPreLaunch
  , prepareTmpDir = helpers.prepareTmpDir
  , requestStartLoggingFormat = require('./helpers.js').requestStartLoggingFormat
  , requestEndLoggingFormat = require('./helpers.js').requestEndLoggingFormat
  , domainMiddleware = require('./helpers.js').domainMiddleware;


var main = function (args, readyCb, doneCb) {
  if (args.asyncTrace) {
    require('longjohn').async_trace_limit = -1;
  }

  if (args.showConfig) {
    try {
      console.log(JSON.stringify(getConfig()));
    } catch (e) {
      process.exit(1);
    }
    process.exit(0);
  }

  checkArgs(parser, args);
  if (typeof doneCb === "undefined") {
    doneCb = function () {};
  }

  var rest = express()
    , server = http.createServer(rest);

  rest.use(domainMiddleware());
  rest.use(morgan(function (tokens, req, res) {
    // morgan output is redirected straight to winston
    logger.info(requestEndLoggingFormat(tokens, req, res),
      (res.jsonResp || '').grey);
  }));
  rest.use(favicon(path.join(__dirname, 'static/favicon.ico')));
  rest.use(express.static(path.join(__dirname, 'static')));
  rest.use(allowCrossDomain);
  rest.use(parserWrap);
  rest.use(bodyParser.urlencoded({extended: true}));
  // 8/18/14: body-parser requires that we supply the limit field to ensure the server can
  // handle requests large enough for Appium's use cases. Neither Node nor HTTP spec defines a max
  // request size, so any hard-coded request-size limit is arbitrary. Units are in bytes (ie "gb" == "GB",
  // not "Gb"). Using 1GB because..., well because it's arbitrary and 1GB is sufficiently large for 99.99%
  // of testing scenarios while still providing an upperbounds to reduce the odds of squirrelliness.
  rest.use(bodyParser.json({limit: '1gb'}));
  rest.use(morgan(function (tokens, req, res) {
    // morgan output is redirected straight to winston
    var data = '';
    try {
      if (req.body) data = JSON.stringify(req.body).substring(0, 1000);
    } catch (ign) {}
    logger.info(requestStartLoggingFormat(tokens, req, res), data.grey);
  }, {immediate: true}));

  rest.use(methodOverride());

  // Instantiate the appium instance
  var appiumServer = appium(args);
  // Hook up REST http interface
  appiumServer.attachTo(rest);

  routing(appiumServer);
  rest.use(catchAllHandler);

  async.series([
    function (cb) {
      configureServer(getConfig(), appiumVer, appiumServer, function (err, rev) {
        if (err) return cb(err);
        appiumRev = rev;
        cb();
      });
    },
    function (cb) {
      prepareTmpDir(args, cb);
    },
    function (cb) {
      conditionallyPreLaunch(args, appiumServer, cb);
    },
    function (cb) {
      startListening(server, args, parser, appiumVer, appiumRev, appiumServer, cb);
    }
  ], function (err) {
    if (err) {
      process.exit(1);
    } else if (typeof readyCb === "function") {
      readyCb(appiumServer);
    }
  });

  server.on('close', function () {
    logFinalWarning();
    doneCb();
  });

};

if (require.main === module) {
  main(args);
}

module.exports.run = main;
