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

Mod = Backbone.Model.extend({
  idAttribute: 'name',

  load: function() { spanner.load(this.id) },
  unload: function() { spanner.unload(this.id) }
})

ModCollection = Backbone.Collection.extend({
  model: Mod,
  url: '/mods.json'
})

spanner = {
  ui: {},

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

  unload: function(name) {
    $('#content [data-mod="' + name + '"]').remove()
    // TODO: unload JS
  },

  init: function() {
    this.ui.logo = new SpannerLogo({el: $('footer .logo')})

    $.when(
      this.load('core/chat'),
      this.load('core/userlist')
    ).done(_.wrap(_.bind(function() {
      this.loadLog()
      this.socket = io.connect()
      this.ui.logo.watchStatus(this.socket)
      this.socket.on('msg', _.bind(this.handleMsg, this))
    }, this), _.defer))

    $.getJSON('me.json', function(data) {
      spanner.me = data
      $('footer .username').text(data.username)
    })

    this.users = new UserCollection()
    this.users.fetch()

    this.mods = new ModCollection()
    this.ui.modlist = new ModList({el: $('footer .mod-list'), collection:this.mods})
    this.mods.fetch()
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

    var localDone = new $.Deferred

    // sync up with server log and store anything we missed
    $.when(
      $.ajax({
        url: 'log.json',
        cache: false,
      }),
      localDone
    ).done(_.bind(function(serverLog, lastTs) {
      _.each(serverLog[0], function(msg) {
        if (msg.ts <= lastTs) { return }
        this.trigger('replay:' + msg.type, msg)
        this.log(msg)
      }, this)
    }, this))

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
    localDone.resolve(lastTs)
  }
}

_.extend(spanner, Backbone.Events)

SpannerLogo = Backbone.View.extend({
  initialize: function() {
    var findLogo = _.bind(function() {
      var svg = this.el.getSVGDocument()
      return svg && $('#spanner', svg)
    }, this)

    this.$logo = findLogo()
    if (!this.$logo) {
      var $logo = this.$logo = new $.Deferred()
      this.el.onload = function() {
        $logo.resolve(findLogo())
      }
    }
  },

  watchStatus: function(socket) {
    socket.on('connect', _.bind(this.setColor, this, 'darkgreen'))
    socket.on('disconnect', _.bind(this.setColor, this, 'darkred'))
  },

  setColor: function(color) {
    $.when(this.$logo).done(function($logo) {
      $logo.css('fill', color)
    })
  }
})

ModList = Backbone.View.extend({
  itemTemplate: _.template('<li><label><input name="<%= d.name %>" type="checkbox"><%= d.name %></label></li>', null, {variable: 'd'}),

  events: {
    'change input[type="checkbox"]': 'toggle'
  },

  initialize: function() {
    this.collection.on('add remove reset', this.render, this)
  },

  render: function() {
    this.$el.empty()
    this.collection.each(function(mod) {
      if (mod.get('creator') == 'builtin') {
        return
      }
      this.$el.append(this.itemTemplate(mod.toJSON()))
    }, this)

    return this
  },

  toggle: function(ev) {
    var $target = $(ev.target),
        name = $target.attr('name'),
        mod = this.collection.get(name)

    if ($target.is(':checked')) {
      mod.load()
    } else {
      mod.unload()
    }
  }
})

spanner.init()
