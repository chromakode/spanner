User = Backbone.Model.extend({
  idAttribute: 'name',
  defaults: function() {
    return {clients: []}
  }
})

UserCollection = Backbone.Collection.extend({
  model: User,
  url: '/who.json',

  initialize: function() {
    spanner.on('join', function(msg) {
      var user = this.get(msg.user)
      if (!user) {
        user = new User({name: msg.user})
        this.add(user)
      }
      user.get('clients').push(msg.client)
    }, this)

    spanner.on('part', function(msg) {
      var user = this.get(msg.user),
          clients = _.reject(user.get('clients'), function(client) {
            return client.id == msg.client.id
          })
      user.set('clients', clients)
      if (_.isEmpty(clients)) {
        this.remove(user)
      }
    }, this)
  }
})

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
    this.logo = new SpannerLogo({el: $('footer .logo')})

    $.when(
      this.load('core/chat'),
      this.load('core/userlist')
    ).done(_.bind(function() {
      this.loadLog()
      this.socket = io.connect()
      this.logo.watchStatus(this.socket)
      this.socket.on('msg', _.bind(this.handleMsg, this))
    }, this))

    $.getJSON('me.json', function(data) {
      spanner.me = data
      $('footer .username').text(data.username)
    })

    this.users = new UserCollection()
    this.users.fetch()
  },

  send: function(msg) {
    this.trigger('send:' + msg.type, msg)
    this.socket.emit('msg', msg, _.bind(this.handleMsg, this))
  },

  handleMsg: function(msg) {
    this.trigger(msg.type, msg)
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
      this.trigger('replay:' + msg.type, msg)
      lastTs = Math.max(lastTs, msg.ts || 0)
    }, this)

    // sync up with server log and store anything we missed
    $.ajax({
      url: 'log.json',
      cache: false,
      success: _.bind(function(log) {
        _.each(log, function(msg) {
          if (msg.ts <= lastTs) { return }
          this.trigger('replay:' + msg.type, msg)
          this.log(msg)
        }, this)
      }, this)
    })
  }
}

_.extend(spanner, Backbone.Events)

SpannerLogo = Backbone.View.extend({
  initialize: function() {
    var loadLogo = this.$logo = new $.Deferred()
    this.el.onload = _.bind(function() {
      var svg = this.el.getSVGDocument(),
          $spanner = $('#spanner', svg)

      loadLogo.resolve($spanner)
    }, this)
  },

  watchStatus: function(socket) {
      socket.on('connect', _.bind(this.setColor, this, 'darkgreen'))
      socket.on('disconnect', _.bind(this.setColor, this, 'darkred'))
  },

  setColor: function(color) {
    this.$logo.done(function($logo) {
      $logo.css('fill', color)
    })
  }
})

spanner.init()
