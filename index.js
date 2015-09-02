/**
 * hive.js
 * Copyright (C) 2013-2015 Marcel Klehr <mklehr@gmx.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 *  along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
var shoe = require('shoe-bin')
  , dataplex = require('dataplex')
  , co = require('co')
  , gulf = require('gulf')
  , through = require('through2')

module.exports = setup
module.exports.consumes = ['hooks','sync', 'auth', 'broadcast']

function setup(plugin, imports, register) {
  var hooks = imports.hooks
    , sync = imports.sync
    , auth = imports.auth
    , broadcast = imports.broadcast

  hooks.on('http:listening', function*(server) {
    sock.install(server, '/socket')
  })

  var sock = shoe(function(stream) {
    var plex = dataplex()
    stream.pipe(plex).pipe(stream)

    plex.add('/document/:id/sync', function(opts) {
      // Set up link authorization
      var link = new gulf.Link({
        authorizeWrite: function(msg, credentials, cb) {
          co(function*() {
            var user = yield auth.authenticate('token', credentials)
              , allowed = false
            switch(msg[0]) {
              case 'edit':
                allowed = yield auth.authorize(user, 'document:change', {document: opts.id})
                break;
              case 'ack':
              case 'requestInit':
                allowed = yield auth.authorize(user, 'document:read', {document: opts.id})
                break;
            }
            return allowed
          })
          .then(function(allowed) {
            cb(null, allowed)
          })
          .catch(cb)
        }
      , authorizeRead:function(msg, credentials, cb) {
          co(function*() {
            var user = yield auth.authenticate('token', credentials)
              , allowed = false
            switch(msg[0]) {
              case 'edit':
                allowed = yield auth.authorize(user, 'document:read', {document: opts.id})
                break;
              case 'ack':
              case 'init':
                allowed = yield auth.authorize(user, 'document:read', {document: opts.id})
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
      stream.on('close', function() {
        b.emit('close')
      })
      return b
    })

    plex.add('/authenticate', function() {
      return through(function(chunk, enc, cb) {
        var that = this
        co(function*() {
          plex.user = yield auth.authenticate('token', chunk.toString('utf8'))
          that.push(JSON.stringify(plex.user))
        })
        .then(cb)
        .catch(cb)
      })
    })


    co(function*() {
      yield hooks.callHook('shoe-interface:connect', plex)
    }).then(function() {})
  })

  register()
}
