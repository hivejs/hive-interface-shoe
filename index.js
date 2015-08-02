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
  , DuplexPassThrough = require('duplex-passthrough')
  , Duplex = require('stream').Duplex
  , PassThrough = require('stream').PassThrough
  , duplexify = require('duplexify')
  , addReadStream = require('src-stream')

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
  
  var broadcasts = []
  var sock = shoe(function(stream) {
    var plex = dataplex()
    stream.pipe(plex).pipe(stream)

    plex.add('/document/:id/sync', function(opts) {
      var link = new gulf.Link
      // Set up link authorization
      link.authorizeFn = function(msg, credentials, cb) {
        co(function*() {
          var user = yield auth.authenticate('token', credentials)
            , allowed = false
          switch(msg[0]) {
            case 'edit':
              allowed = yield auth.authorize(user, 'document:change', {document: opts.id})
              break;
            case 'ack':
            case 'requestInit':
              allowed = yield auth.authorize(user, 'document/snapshots:index', {document: opts.id})
              break;
          }
          return allowed
        })
        .then(function(allowed) {
          cb(null, allowed)
        })
        .catch(cb)
      }
      co(function*() {
        if(!(yield auth.authorize(plex.user, 'document/snapshots:index', {document: opts.id}))) return
        // load document and add slave link
        var doc = yield sync.getDocument(opts.id)
        doc.attachSlaveLink(link)
      })
      .then(function() {})
      .catch(function(er) { throw new er})
      return link
    })
    
    plex.add('/document/:id/broadcast', function(opts) {
      co(function*(){
        if(!(yield auth.authorize(plex.user, 'document/snapshots:index', {document: opts.id}))) return

        var upstream = broadcast.document(opts.id) // the broadcast received by the other workers 
        
        // Write incoming local messages to upstream (other workers), as well as to all broadcasts (local clients)
        var writable = new PassThrough
        writable.pipe(upstream)
        writeable.pipe(through(function(buf, enc, cb) {
          broadcasts.forEach(function(s) {
            s.write(buf)
          })
          cb()
        }))
        
        // Read messages from upstream (other workers) as well as from other clients
        var passiveBroadcast = new PassThrough // will get written to by other clients
          , readable = upstream.pipe(addReadStream(passiveBroadcast))
        broadcasts.push(passiveBroadcast)
        
        // return the magical hybrid
        s.wrapStream(duplexify(writable, readable))
        
        // remove this from broadcasts if the stream ends
        stream.on('end', function() {
          broadcasts.splice(broadcasts.indexOf(passiveBroadcast), 1)
        })
      }).then(function(){})
      var s = DuplexPassThrough(null)
      return stream
    })

    plex.add('/authenticate', function() {
      return through(function(chunk, enc, cb) {
        co(function*() {
          plex.user = yield auth.authenticate('token', chunk.toString(enc))
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