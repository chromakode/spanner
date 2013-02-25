var fs = require('fs')
  , _ = require('underscore')
  , express = require('express')
  , SessionSockets = require('session.socket.io')
  , connect = require('connect')
  , connectCouch = require('connect-couchdb')(connect)
  , cradle = require('cradle')
  , bcrypt = require('bcrypt')
  , config = require('./config.js')


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
      key: fs.readFileSync(__dirname + '/keys/key.pem'),
      cert: fs.readFileSync(__dirname + '/keys/cert.pem')
  }, app)
  , io = require('socket.io').listen(server)

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
    data = {}
    _.each(io.sockets.clients(), function(socket) {
      var user = socket.handshake.username

      if (!data[user]) {
        data[user] = {clients: {}}
      }

      var info = this.clientInfo(socket)
      data[user].clients[info.id] = info
      delete info.id
    }, this)
    return data
  }
}

var couchSessions = new connectCouch({name: 'spanner-sessions'})
couch.database(couchSessions.db.name).exists(function(err, exists) {
  if (!exists) {
    console.log('setting up sessions couch db')
    couchSessions.setup({revs_limit: 10})
  }
})

app.use(express.bodyParser())
var cookieParser = connect.cookieParser(config.secret)
app.use(cookieParser)
app.use(connect.session({store: couchSessions}))

app.get('/', function(req, res) {
  if (!req.session.username) {
    res.redirect('/login')
  } else {
    res.sendfile(__dirname + '/public/index.html')
  }
})

app.use(express.static(__dirname + '/public'))

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

app.all('*', function(req, res, next) {
  if (!req.session.username) {
    res.send(403)
  } else {
    next()
  }
})

app.get('/mod/:name.html', function(req, res) {
  moddb.get(req.params.name, function(err, doc) {
    res.set('Content-Type', 'text/javascript');
    if (err) {
      if (err.error == 'not_found') {
        res.send(404)
      } else {
        console.log('couch error', err)
      }
    } else {
      res.send(doc.body)
    }
  })
})

app.put('/mod/:name.html', function(req, res) {
  function save(body) {
    moddb.get(req.params.name, function(err, doc) {
      doc = doc || {}
      doc.body = body
      moddb.save(req.params.name, doc, function(err, doc) {
        if (err) {
          console.log('couch put error', err)
          res.send(500)
        } else {
          res.send(200)
        }
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

app.get('/mod.json', function(req, res) {
  moddb.all(function(err, docs) {
    var mods = docs.map(function(key, doc) {
      return key
    })
    fs.readdir(__dirname + '/public/mod/core/', function(err, filenames) {
      res.send(mods.concat(filenames))
    })
  })
})

app.get('/me.json', function(req, res) {
  res.send({
    username: req.session.username
  })
})

app.get('/log.json', function(req, res) {
  msgLog.fetch(function(log) {
    res.send(log)
  })
})

app.get('/who.json', function(req, res) {
  res.send(userlist.list())
})


var sio = new SessionSockets(io, couchSessions, cookieParser)
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
  server.listen(config.port)
}
