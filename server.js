var fs = require('fs')
  , express = require('express')
  , app = express()
  , server = require('http').createServer(app)
  , io = require('socket.io').listen(server)
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

app.get('/', function(req, res) {
  if (!req.session.username) {
    res.redirect('/login')
  } else {
    res.sendfile(__dirname + '/public/index.html')
  }
})

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

var sio = new SessionSockets(io, couchSessions, cookieParser)
sio.on('connection', function(err, socket, session) {
  socket.on('msg', function(msg, cb) {
    msg.ts = Date.now()
    msg.user = session.username
    msgLog.log(msg)
    socket.broadcast.emit('msg', msg)
    cb(msg)
  })
})

app.use(express.static(__dirname + '/public'))

if (!module.parent) {
  server.listen(8080)
}
