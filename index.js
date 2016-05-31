/** 
 * hive.js 
 * Copyright (C) 2013-2016 Marcel Klehr <mklehr@gmx.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the Mozilla Public License version 2
 * as published by the Mozilla Foundation.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the Mozilla Public License
 * along with this program.  If not, see <https://www.mozilla.org/en-US/MPL/2.0/>.
 */
var Primus = require('primus')
  , dataplex = require('dataplex')
  , co = require('co')
  , gulf = require('gulf')
  , through = require('through2')

module.exports = setup
module.exports.consumes = ['hooks','http','sync', 'auth', 'broadcast', 'config']
module.exports.provides = ['interfaceStream']

function setup(plugin, imports, register) {
  var hooks = imports.hooks
    , http = imports.http
    , sync = imports.sync
    , auth = imports.auth
    , broadcast = imports.broadcast
    , config = imports.config

  // Hack, because primus and the router don't know about each other
  http.router.all('/stream/*', function*(){this.respond=false})

  var primus = new Primus(http.server, {
    pathname:'/stream'
  , authorization: null
  , parser: 'binary'
  , transformer: config.get('interfaceStream:transport')
  })

  primus.use('client-side-binary-converter', {
    client: function(primus) {
      primus.transform('incoming', function (packet) {
        packet.data = new Buffer(packet.data)
      });

      primus.transform('outgoing', function (packet) {
        // convert node Buffers to Arraybuffers as per
        // https://stackoverflow.com/questions/8609289/convert-a-binary-nodejs-buffer-to-javascript-arraybuffer#12101012
        // var arrayBuffer = new Uint8Array(nodeBuffer).buffer
        packet.data = (new Uint8Array(packet.data)).buffer
      });
    }
  })

  primus.on('connection',function(stream) {
    var plex = dataplex()
    stream.pipe(plex).pipe(stream)

    plex.add('/document/:id/sync', function(opts) {
      // Set up link authorization
      var link = new gulf.Link({
        authenticate: function(credentials, cb) {
          co(function*() {
            return yield auth.authenticate('token', credentials)
          })
          .then((user) => {
            cb(null, user.id)
          })
          .catch(cb)
        }
      , authorizeWrite: function(msg, user, cb) {
          co(function*() {
            if(!plex.user) return false
            var allowed = false
            switch(msg[0]) {
            case 'edit':
              allowed = yield auth.authorize(plex.user, 'document:change', {id: opts.id})
              break;
            case 'ack':
            case 'requestInit':
              allowed = yield auth.authorize(plex.user, 'document:read', {id: opts.id})
              break;
            }
            return allowed
          })
          .then(function(allowed) {
            cb(null, allowed)
          })
          .catch(cb)
        }
      , authorizeRead:function(msg, user, cb) {
          co(function*() {
            if(!plex.user) return false
            var allowed = false
            switch(msg[0]) {
            case 'edit':
              allowed = yield auth.authorize(plex.user, 'document:read', {id: opts.id})
              break;
            case 'ack':
            case 'init':
              allowed = yield auth.authorize(plex.user, 'document:read', {id: opts.id})
              break;
            }
            return allowed
          })
          .then(function(allowed) {
            cb(null, allowed)
          })
          .catch(cb)
        }
      })

      co(function*() {
        // load document and add slave link
        var doc = yield sync.getDocument(opts.id)
        doc.attachSlaveLink(link)
      })
      .then(function() {}, function(er) { console.log(er.stack || er)})

      return link
    })

    plex.add('/document/:id/broadcast', function(opts) {
      var b = broadcast.document(opts.id, plex.user)
      stream.on('end', function() {
        b.emit('close')
      })
      return b
    })

    plex.add('/authenticate', function() {
      return through(function(chunk, enc, cb) {
        var that = this
        co(function*() {
          try {
            plex.user = yield auth.authenticate('token', chunk.toString('utf8'))
            if(plex.user) return that.push(JSON.stringify({authenticated: true}))
          }catch(e) { }
          that.push(JSON.stringify({authenticated: false }))
        })
        .then(cb)
        .catch(cb)
      })
    })


    co(function*() {
      yield hooks.callHook('interface-stream:connect', plex)
    }).then(function() {})
  })

  register(null, {interfaceStream: {primus: primus}})
}
