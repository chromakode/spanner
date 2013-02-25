spanner = {
  load: function(name) {
    return $.ajax({
      url: '/mod/' + name + '.html',
      success: function(data) {
        $('<div>').attr('data-mod', name)
          .append(data)
          .appendTo('#content')
        less.refreshStyles()
      }
    })
  },

  init: function() {
    $.when(
      this.load('core/chat'),
      this.load('core/userlist')
    ).done(_.bind(function() {
      this.loadLog()
      this.socket = io.connect()
      this.socket.on('connect', _.bind(this.colorLogo, this, 'darkgreen'))
      this.socket.on('disconnect', _.bind(this.colorLogo, this, 'darkred'))
      this.socket.on('msg', _.bind(this.handleMsg, this))
    }, this))

    $.getJSON('me.json', function(data) {
      spanner.me = data
      $('footer .username').text(data.username)
    })

    spanner.userlist = {}
    $.getJSON('who.json', function(data) {
      _.extend(spanner.userlist, data)
    })
  },

  colorLogo: function(color) {
    spanner.$logo.done(function($logo) {
      $logo.css('fill', color)
    })
  },

  listeners: {},
  on: function(types, cb) {
    _.each(types.split(' '), function(type) {
      if (!this.listeners[type]) {
        this.listeners[type] = []
      }
      this.listeners[type].push(cb)
    }, this)
  },

  off: function(types, cb) {
    _.each(types.split(' '), function(type) {
      if (this.listeners[type]) {
        this.listeners[type] = _.without(this.listeners[type], cb)
      }
    })
  },

  _trigger: function(type/*, ... */) {
    var listeners = this.listeners[type],
        params = _.tail(arguments)
    if (listeners) {
      _.each(listeners, function(cb) {
        cb.apply(null, params)
      })
    }
  },

  send: function(msg) {
    this._trigger('send:' + msg.type, msg)
    this.socket.emit('msg', msg, _.bind(this.handleMsg, this))
  },

  handleMsg: function(msg) {
    if (msg.type == 'join') {
      if (!this.userlist[msg.user]) {
        this.userlist[msg.user] = {clients: {}}
      }
      this.userlist[msg.user].clients[msg.client.id] = msg.client
    } else if (msg.type == 'part') {
      delete this.userlist[msg.user].clients[msg.client.id]
      if (_.isEmpty(this.userlist[msg.user].clients)) {
        delete this.userlist[msg.user]
      }
    }

    this._trigger(msg.type, msg)
    this.log(msg)
  },

  log: function(msg) {
    if (!sessionStorage) { return }
    this._log.push(msg)
    sessionStorage.log = JSON.stringify(this._log)
  },

  loadLog: function() {
    if (!sessionStorage) { return }

    try {
      this._log = JSON.parse(sessionStorage.log)
    } catch (e) {}

    if (!this._log) {
      this._log = []
    }

    // restore local log (fast)
    var lastTs = 0
    _.each(this._log, function(msg) {
      this._trigger('replay:' + msg.type, msg)
      lastTs = Math.max(lastTs, msg.ts || 0)
    }, this)

    // sync up with server log and store anything we missed
    $.ajax({
      url: 'log.json',
      cache: false,
      success: _.bind(function(log) {
        _.each(log, function(msg) {
          if (msg.ts <= lastTs) { return }
          this._trigger('replay:' + msg.type, msg)
          this.log(msg)
        }, this)
      }, this)
    })
  }
}

spanner.$logo = new $.Deferred()
$(function() {
  var $logo = $('footer .logo')
  $logo[0].onload = function() {
    var svg = $logo[0].getSVGDocument(),
        $spanner = $('#spanner', svg)

    spanner.$logo.resolve($spanner)
  }
})

spanner.init()
