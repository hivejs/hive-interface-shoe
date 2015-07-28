var shoe = require('shoe-bin')
  , dataplex = require('dataplex')
  , co = require('co')
  , gulf = require('gulf')
  , through = require('through2')

module.exports = setup
module.exports.consumes = ['hooks','sync', 'auth']

function setup(plugin, imports, register) {
  var hooks = imports.hooks
    , sync = imports.sync
    , auth = imports.auth
  
  hooks.on('http:listening', function*(server) {
    sock.install(server, '/socket')
  })
  
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