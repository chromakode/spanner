var fs = require('fs')
  , _ = require('underscore')
  , express = require('express')
  , SessionSockets = require('session.socket.io')
  , connect = require('connect')
  , connectCouch = require('connect-couchdb')(connect)
  , cradle = require('cradle')
  , bcrypt = require('bcrypt')
  , config = require('./config.js')

var COOKIE_NAME = 'me'

var couch = new cradle.Connection()
  , moddb = exports.moddb = couch.database('spanner-mods')
  , userdb = exports.userdb = couch.database('spanner-users')
  , logdb = exports.logdb = couch.database('spanner-log')

;[moddb, userdb].forEach(function(db) {
  db.exists(function(err, exists) {
    if (!exists) {
      db.create()
    }
  })
})

logdb.exists(function(err, exists) {
  if (!exists) {
    logdb.create(function() {
      logdb.save('_design/log', {
        byDate: {
          map: function (doc) {
            emit(doc.ts, doc)
          }
        }
      })
    })
  }
})


var app = express()
  , server = require('https').createServer({
      key: fs.readFileSync(config.ssl.keyPath),
      cert: fs.readFileSync(config.ssl.certPath),
      ca: config.ssl.caPath && fs.readFileSync(config.ssl.caPath)
  }, app)
  , io = require('socket.io').listen(server)

var httpRedirectApp = express()
httpRedirectApp.get('*', function(req, res) {
  res.redirect(config.origin + req.url)
})

msgLog = {
  fetchLimit: 1000,

  log: function(msg) {
    logdb.save(msg, function(err, doc) {
      if (err) {
        console.log('couch put error', err)
      }
    })
  },

  fetch: function(cb) {
    opts = {limit: this.fetchLimit, descending: true}
    logdb.view('log/byDate', opts, function(err, res) {
      if (err) {
        console.log('couch log view error', err)
      } else {
        res = res.toArray()
        res.reverse()
        res.forEach(function(doc) {
          delete doc._id
          delete doc._rev
        })
        cb(res)
      }
    })
  }
}

userlist = {
  _users: {},

  join: function(socket) {
    return {
      type: 'join',
      user: socket.handshake.username,
      client: this.clientInfo(socket)
    }
  },

  part: function(socket) {
    return {
      type: 'part',
      user: socket.handshake.username,
      client: this.clientInfo(socket)
    }
  },

  clientInfo: function(socket) {
    return {
      id: socket.id,
      ua: socket.handshake.headers['user-agent']
    }
  },

  list: function() {
    users = {}
    _.each(io.sockets.clients(), function(socket) {
      var name = socket.handshake.username

      if (!users[name]) {
        users[name] = {clients: []}
      }

      users[name].clients.push(this.clientInfo(socket))
    }, this)

    users = _.map(users, function(info, name) {
      info.name = name
      return info
    })
    return users
  }
}

var couchSessions = new connectCouch({name: 'spanner-sessions'})
couch.database(couchSessions.db.name).exists(function(err, exists) {
  if (!exists) {
    console.log('setting up sessions couch db')
    couchSessions.setup({revs_limit: 10})
  }
})

app.use(express.logger())
app.use(express.bodyParser())
var cookieParser = connect.cookieParser(config.secret)
app.use(cookieParser)
app.use(connect.session({
  key: COOKIE_NAME,
  store: couchSessions,
  cookie: {secure: true, maxAge: 7*24*60*60*1000}
}))

app.get('/', function(req, res) {
  if (!req.session.username) {
    res.redirect('/login')
  } else {
    res.sendfile(__dirname + '/public/index.html')
  }
})

app.use('/static', express.static(__dirname + '/public'))
app.use('/mod', express.static(__dirname + '/mod'))

app.get('/login', function(req, res) {
  res.sendfile(__dirname + '/public/login.html')
})

app.post('/login', function(req, res) {
  if (!req.body.username || !req.body.password) {
    res.send(400)
    return
  }
  userdb.get(req.body.username, function(err, doc) {
    if (err) {
      if (err.error == 'not_found') {
        res.send(403)
      } else {
        res.send(500)
      }
    } else {
      bcrypt.compare(req.body.password, doc.password, function(err, matched) {
        if (matched) {
          req.session.username = req.body.username
          res.redirect('/')
        } else {
          res.send(403)
        }
      })
    }
  })
})

app.post('/signup', function(req, res) {
  if (req.body.key != config.signupKey) {
    res.send(403)
    return
  }

  if (!req.body.username || !req.body.password) {
    res.send(400)
    return
  }

  bcrypt.hash(req.body.password, 10, function(err, encPassword) {
    userdb.save(req.body.username, {password: encPassword}, function(err, doc) {
      if (err) {
        res.send(500)
      } else {
        res.send(200)
      }
    })
  })
})

function requireAuth(req, res, next) {
  if (!req.session.username) {
    res.send(403)
  } else {
    next()
  }
}

app.get('/mod/:name.html', requireAuth, function(req, res) {
  moddb.getAttachment(req.params.name, 'content', function(err, doc) {
    res.set('Content-Type', 'text/html');
    if (err) {
      console.log('couch error', err)
      res.send(500)
    } else if (doc.statusCode == 404) {
      res.send(404)
    } else {
      res.send(doc.body)
    }
  })
})

app.put('/mod/:name.html', requireAuth, function(req, res) {
  function save(body) {
    moddb.get(req.params.name, function(err, doc) {
      doc = doc || {creator: req.session.username}
      doc.uploader = req.session.username
      doc.ts = Date.now()
      moddb.save(req.params.name, doc, function(err, doc) {
        if (err) {
          console.log('couch put error', err)
          res.send(500)
          return
        }

        var attachment = {
          name: 'content',
          contentType: 'text/html',
          body: body
        }
        moddb.saveAttachment(doc, attachment, function(err, doc) {
          if (err) {
            console.log('couch put attachment error', err)
            res.send(500)
          } else {
            res.send(200)
          }
        })
      })
    })
  }

  var file = req.files.content
  if (file) {
    fs.readFile(file.path, 'utf-8', function(err, data) {
      save(data)
      fs.unlink(file.path)
      res.send(200)
    })
  } else if (req.body.content) {
    save(req.body.content)
  } else {
    res.send(400)
  }
})

app.get('/mods.json', requireAuth, function(req, res) {
  moddb.all({include_docs: true}, function(key, docs) {
    var mods = docs.map(function(key, doc) {
      var info = _.pick(doc, 'creator', 'uploader', 'ts')
      info.name = key
      return info
    })
    fs.readdir(__dirname + '/mod/core', function(err, filenames) {
      _.each(filenames, function(filename) {
        mods.push({
          name: 'core/' + filename.split('.')[0],
          creator: 'builtin'
        })
      })
      res.send(mods)
    })
  })
})

app.get('/me.json', requireAuth, function(req, res) {
  res.send({
    user: req.session.username
  })
})

app.get('/log.json', requireAuth, function(req, res) {
  msgLog.fetch(function(log) {
    res.send(log)
  })
})

app.get('/who.json', requireAuth, function(req, res) {
  res.send(userlist.list())
})


var sio = new SessionSockets(io, couchSessions, cookieParser, COOKIE_NAME)
io.configure(function() {
  io.set('authorization', function(handshakeData, callback) {
    sio.getSession({handshake: handshakeData}, function(err, session) {
      handshakeData.username = session.username
      callback(err, !!session.username)
    })
  })
})

sio.on('connection', function(err, socket, session) {
  io.sockets.emit('msg', userlist.join(socket))

  socket.on('msg', function(msg, cb) {
    if (msg.type == 'join' || msg.type == 'part') {
      // don't allow join/part spoofing
      return
    }

    msg.ts = Date.now()
    msg.user = session.username
    msgLog.log(msg)
    socket.broadcast.emit('msg', msg)
    cb(msg)
  })

  socket.on('disconnect', function() {
    socket.broadcast.emit('msg', userlist.part(socket))
  })
})

if (!module.parent) {
  httpRedirectApp.listen(config.port.http)
  server.listen(config.port.https)
}
