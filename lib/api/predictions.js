var http = require('http'),
    zlib = require('zlib'),
    qs = require('querystring'),
    cheerio = require('cheerio'),
    utils = require('../utils'),
    NBXML_FEED = utils.c.NEXTBUS_XMLFEED,
    predictions = {};

predictions.get = function(req, res) {
  var p = req.params,
      a = p.agency,
      r = p.route,
      s = p.stop,
      path = p.path || [NBXML_FEED, '?command=predictions&a=', a, '&r=', r, '&s=', s].join('');

  http.get(utils.getOptionsWithPath(path), function(nbres) {
    utils.getJsFromXml(nbres, function(err, js) {
      var json = [], nberr;

      if(!err) {
        nberr = js.body.Error && js.body.Error[0];
        if(!nberr) {
          // Predictions for each route (if they exist).
          js.body.predictions.forEach(function(pred) {
            var $ = pred.$,
                messages = pred.message,
                p = {};

            if(!$.dirTitleBecauseNoPredictions) {
              p.agency = {
                id: null,
                title: $.agencyTitle,
                logoUrl: null
              };
              p.route = {
                id: $.routeTag,
                title: $.routeTitle
              };
              p.stop = {
                id: $.stopTag,
                title: $.stopTitle,
                distance: null
              };
              p.messages = [];
              if(messages) messages.forEach(function(m) {
                p.messages.push({ text: m.$.text, priority: m.$.priority });
              });

              p.values = [];
              // Prediction values for each route direction
              pred.direction.forEach(function(direction) {
                direction.prediction.forEach(function(prediction) {
                  var $$ = prediction.$,
                      v = {};

                  v.epochTime = parseInt($$.epochTime, 10);
                  v.seconds = parseInt($$.seconds, 10);
                  v.minutes = parseInt($$.minutes, 10);
                  v.branch = !$$.branch ? null : $$.branch;
                  v.isDeparture = !!($$.isDeparture === 'true');
                  v.affectedByLayover = !$$.affectedByLayover ? false : true;
                  v.isScheduleBased = !$$.isScheduleBased ? false : true;
                  v.vehicle = {
                    id: $$.vehicle,
                    block: $$.block,
                    trip: !$$.tripTag ? null : $$.tripTag
                  };
                  v.direction = {
                    id: $$.dirTag,
                    title: direction.$.title
                  };

                  p.values.push(v);
                });
              });

              // Sort the prediction values in ascending order
              p.values.sort(function(a, b) {return a.epochTime - b.epochTime;});

              json.push(p);
            } // else there are no predictions thus json === [empty].
          });

          res.json(200, json);
        } else utils.nbXmlError(nberr, res);
      } else utils.streamOrParseError(err, js, res);
    });
  }).on('error', function(e) { utils.nbRequestError(e, res); });
};

/**
 * Method for returning predictions for every route passing through a stop. Uses the stopId (code) property
 * for a stop from the NextBus XML feed. Wrapper of predictions.get() but doesn't require a route id.
 *
 * @uri /agencies/:agency/stops/:code/predictions
 *
 * @param {Object:req} The node native http.ClientRequest object.
 * @param {Object:res} The node native http.ServerResponse object.
 */
predictions.list = function(req, res) {
  var p = req.params;

  p.path = [NBXML_FEED, '?command=predictions&a=', p.agency, '&stopId=', p.code].join('');
  predictions.get(req, res);
};

/**
 * Tuples <====> F:5650 (route-id:stop-id)
 * @uri /agencies/:agency/tuples/:tuples/predictions e.g. /agencies/sf-muni/tuples/F:5650,N:6997/predictions
 *
 * @param {Object:req} The node native http.ClientRequest object.
 * @param {Object:res} The node native http.ServerResponse object.
 */

predictions.tuples = function(req, res) {
  var p = req.params,
      tuples = p.tuples,
      q = '';

  tuples.split(',').forEach(function(tuple) { q += ['&', 'stops=', tuple.replace(':', '|')].join(''); });
  p.path = [NBXML_FEED, '?command=predictionsForMultiStops&a=', p.agency, q].join('');
  predictions.get(req, res);
};

/**
 * Method for predictions by geolocation.
 *
 * Uses the JSON feed I started (but never finished) while at NextBus Inc. to
 * support their next generation mobile app.  This project never came to fruition,
 * and the JSON responses from NextBus are unpolished but useable nevertheless. One
 * nuance is that the actual JSON response object (org.json.JSONObject) used
 * by the servlet behind this request, is only created once in the constructor!
 * Therefore, any previous error will always be present in the JSON for subsequent
 * successful requests due to this undesired caching affect. Luckily the "preds" property
 * of this JSONObject is always overwritten on successful requests, so the NextBus
 * endpoint can still be used to get the data. However, this means there is no real
 * effective error checking from the NextBus endpoint after the first error since their
 * server has been restarted.
 *
 * UNSTABLE: The data from NextBus behind this request can be removed at any moment and
 * without notice. Use this particular method at your own risk.
 *
 * @param {Object:req} The node native http.ClientRequest object.
 * @param {Object:res} The node native http.ServerResponse object.
 */
predictions.location = function(req, res) {
  var p = req.params,
      latlon = p.latlon,
      alatlon = latlon.split(','),
      latlonrgx = /^([-+]?\d{1,2}([.]\d+)?),\s*([-+]?\d{1,3}([.]\d+)?)$/,
      layoverrgx = /sup/gi,
      busatstoprgx = /arriving|due|departing/gi,
      postdata, options, postreq;

  if(latlonrgx.test(latlon)) {
    postdata = qs.stringify({
      preds: 'byLoc',
      maxDis: '2300',
      accuracy: '2400',
      lat: alatlon[0].trim(),
      lon: alatlon[1].trim()
    });
    options = {
      hostname: 'www.nextbus.com',
      path: '/service/mobile',
      method: 'POST',
      port: 80,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': postdata.length
      }
    };
    postreq = http.request(options, function(nbres) {
      var nbjson = '';

      nbres.on('data', function(d) { if(d) nbjson += d; });

      nbres.on('end', function() {
        var json = [],
            parseErr = false;

        try {
          nbjson = JSON.parse(nbjson);
        } catch(e) {
          parseErr = true;
        } finally {
          if(!parseErr) {
            if(nbjson.preds) {
              nbjson.preds.forEach(function(pred) {
                var p = {},
                    pfs = pred.pred_for_stop,
                    ps = pred.pred_str.replace(/minutes|min|mins/g,'').trim(),
                    directionTitle = pred.route_dir,
                    aps;

                p.agency = {
                  id: pfs.a,
                  title: pred.agency_name,
                  logoUrl: pred.agency_logo
                };
                p.route = {
                  id: pfs.r,
                  title: pred.route_name
                };
                p.stop = {
                  id: pfs.s,
                  title: pred.stop_name,
                  distance: pred.stop_distance
                };
                p.messages = [];
                pred.agency_msgs.forEach(function(msg) {
                  p.messages.push({text: msg, priority: null});
                });
                p.values = [];
                aps = ps.split('&');
                aps.forEach(function(pstr) {
                  var v = {}, affected = false, mins = 0;

                  // Check if the prediction value is affected by a layover.
                  if(layoverrgx.test(pstr)) affected = true;

                  // Check if the prediction is not zero minutes, i.e. the bus is not at the stop.
                  if(!busatstoprgx.test(pstr)) {
                    mins = parseInt(pstr.replace("<SUP>*</SUP>", ''), 10);
                  }

                  v.epochTime = null;
                  v.seconds = isNaN(mins) ? -1 : mins * 60;
                  v.minutes = isNaN(mins) ? -1 : mins;
                  v.branch = null;
                  v.isDeparture = null;
                  v.affectedByLayover = affected;
                  v.isScheduleBased = null;
                  v.vehicle = null;
                  v.direction = {
                    id: null,
                    title: directionTitle
                  };

                  p.values.push(v);
                });
                json.push(p);
              });
            }
            res.json(200, json);
          } else res.json(500, utils.errors.get(500, 'Unable to parse JSON from ' + options.hostname + '.'));
        }
      });

      nbres.on('error', function(e) {
        res.json(500, utils.errors.get(500, 'Unable to fulfill request to ' + options.hostname + '. ' + e.message));
      });

    }).on('error', function(e) { utils.nbRequestError(e, res); });

    postreq.write(postdata);
    postreq.end();
  } else res.json(404, utils.errors.get(404, 'A valid lat,lon pair is required.'));
};

/**
 * EXPERIMENTAL: Method for predictions by location. Parses HTML returned from NextBus Inc.
 *
 * This would be a much more stable and reliable version of predictions.location() since
 * the data source is a stable NextBus product that is unlikely to disappear. However,
 * it requires parsing terribly invalid HTML and other hurdles to cleanly get the data.
 *
 * TODO: Finish this. Incomplete as of 2/11/2014.
 *
 * @param {Object:req} The node native http.ClientRequest object.
 * @param {Object:res} The node native http.ServerResponse object.
 */
predictions.locationredux = function(req, res) {
  var p = req.params,
      latlon = p.latlon.split(','),
      lat = latlon[0],
      lon = latlon[1],
      options = {
        hostname: 'www.nextbus.com',
        path: ['/webkit/predsByLoc.jsp?lat=', lat, '&lon=', lon, '&maxDis=2300&maxNumStops=32'].join(''),
        headers: {'accept-encoding' : 'gzip,deflate'}
      };

  http.get(options, function(nbres) {
    var encoding = nbres.headers['content-encoding'], stream = nbres, html = '';

    if(encoding === 'gzip' || encoding == 'deflate') {
      stream = zlib.createUnzip();
      nbres.pipe(stream);
    }

    stream.on('data', function(d) { if(d) html += d.toString(); });

    stream.on('end', function() {
      var $ = cheerio.load(html.trim(), { normalizeWhitespace: false }), json = [];

      $('div.plainText').each(function(idx, agency) {
        var agencyTitle = $('span.agencyName', this).text(), messages = [];

        // Build messages
        $('.message', this).each(function(idx, message) {
          messages.push({text: $(this).text(), priority: null});
        });

        $('.inBetweenRouteSpacer', this).each(function(idx, route) {
          var routeTitle = $('span.routeName', this).text(),
              p = {};

          p.agencyTitle = agencyTitle;
          p.route = {
            title: routeTitle
          };
          p.messages = messages;
          json.push(p);
        });
      });
      res.json(200, json);
    });

    stream.on('error', function(e) {
      res.json(500, utils.errors.get(500, 'Unable to fulfill request to ' + options.hostname + '. ' + e.message));
    });

  }).on('error', function(e) { utils.nbRequestError(e, res); });
};

module.exports = predictions;