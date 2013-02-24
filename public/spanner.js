var socket = io.connect()

spanner = {
  load: function(name) {
    $.ajax({
      url: '/mod/' + name + '.html',
      success: function(data) {
        $('<div>').attr('data-mod', name)
          .append(data)
          .appendTo('#content')
        less.refreshStyles()
      }
    })
  }
}

spanner.load('core/chat')

$.getJSON('me.json', function(data) {
  spanner.me = data
  $('footer .username').text(data.username)
})

$(function() {
  var $logo = $('footer .logo')
  $logo[0].onload = function() {
    var svg = $logo[0].getSVGDocument(),
        $spanner = $('#spanner', svg)

    if (socket.socket.connected) {
      $spanner.css('fill', 'darkgreen')
    }

    socket.on('connect', function() {
      $spanner.css('fill', 'darkgreen')
    })

    socket.on('disconnect', function() {
      $spanner.css('fill', 'darkred')
    })
  }
})
