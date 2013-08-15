/**
 * Content script to be injected to Google Play Music.
 * This watches the DOM for relevant changes and notifies the background page.
 * It also delivers commands to the Google Play Music window.
 * @author Sven Recknagel (svenrecknagel@googlemail.com)
 * Licensed under the BSD license
 */
$(function() {
  var port;
  var registeredListeners = [];
  var observers = [];
  var executeOnContentLoad;
  var contentLoadDestination;
  var listRatings;
  
  /** send update to background page */
  function post(type, value) {
    if (port) {
      port.postMessage({type: type, value: value});
    }
  }
  
  /** @return link (for hash) constructed from attributes data-type and data-id */
  function getLink(el) {
    if (el.data("id")) {
      return el.data("type") + "/" + el.data("id");
    }
    return null;
  }
  
  function parseCover(el) {
    var cover = el.attr("src");
    if (cover && cover.indexOf("//") == 0) cover = "https:" + cover;
    return cover;
  }
  
  function parseRating(rating) {
    rating = parseInt(rating);
    return isNaN(rating) ? -1 : rating;
  }

  function sendQuickLinks() {
    var ql = {texts: {}};
    var nav = $("#nav_collections");
    ql.texts.now = $.trim(nav.children("li[data-type='now']").text());
    ql.texts.rd = $.trim(nav.children("li[data-type='rd']").text());
    var br = $("#browse-tabs");
    ql.texts.artists = $.trim(br.children("div[data-type='artists']").text());
    ql.texts.albums = $.trim(br.children("div[data-type='albums']").text());
    ql.texts.genres = $.trim(br.children("div[data-type='genres']").text());
    var apl = {};
    $("#auto-playlists").children("li").each(function() {
      apl[getLink($(this))] = $.trim($(this).find("div.tooltip").text());
    });
    ql.autoPlaylists = apl;
    post("player-quicklinks", ql);
  }
  
  /**
   * Execute a function after DOM manipulation on selected elements is finished.
   * @param fn function to execute, gets the jQuery object for the selector as parameter
   * @param selector element(s) to be watched for DOM manipulation
   * @param removeAfterExecute if true, the function will be called only once, otherwise the event listener stays attached
   * @param timeout time to wait after DOM manipulation before executing the function
   */
  function executeAfterContentLoad(fn, selector, timeout) {
    var content = $(selector);
    if (content.length == 0) {
      console.error("element does not exist (did Google change their site?): " + selector);
      return;
    }
    var contentTimer;
    var listener = function() {
      clearTimeout(contentTimer);
      contentTimer = setTimeout(function() {
        contentTimer = null;
        fn(content);
      }, timeout);//wait til the DOM manipulation is finished
    };
    content.on("DOMSubtreeModified", listener);
    registeredListeners.push({ selector: selector, listener: listener });
    listener();
  }
  
  function init() {
    //when rating is changed, the page gets reloaded, so no need for event listening here
    var ratingMode;
    var ratingContainer = $("#player-right-wrapper > div.player-rating-container > ul.rating-container");
    if (ratingContainer.hasClass("thumbs")) ratingMode = "thumbs";
    else if (ratingContainer.hasClass("stars")) ratingMode = "star";
    ratingContainer = null;
    post("player-ratingMode", ratingMode);
    
    function sendSong() {
      var hasSong = $("#playerSongInfo").find("div").length > 0;
      var info = null;
      if (hasSong) {
        var artist = $("#player-artist");
        var album = $("#playerSongInfo").find(".player-album");
        var cover = parseCover($("#playingAlbumArt"));
        info = {
          duration: $.trim($("#time_container_duration").text()),
          title: $.trim($("#playerSongTitle").text()),
          artist: $.trim(artist.text()),
          artistLink: getLink(artist),
          album: $.trim(album.text()),
          albumLink: getLink(album),
          cover: cover
        };
      }
      post("song-info", info);
    }
    
    function sendPosition(el) {
      post("song-position", $.trim(el.text()));
    }
    
    function playingGetter(el) {
      var play = $(el);
      return play.is(":disabled") ? null : play.hasClass("playing");
    }
    
    function ratingGetter(el) {
      return parseRating($(el.parentElement).find("li.selected").data("rating"));
    }
    
    function mainLoaded() {
      if (typeof(executeOnContentLoad) == "function") {
        if (contentLoadDestination && location.hash != contentLoadDestination) return;//wait til we are on the correct page
        var fn = executeOnContentLoad;
        executeOnContentLoad = null;
        contentLoadDestination = null;
        fn();
      }
    }
    
    /**
     * Watch changes of attributes on DOM elements specified by the selector.
     * @param attrs the space separated names of the attributes
     * @param selector the jQuery selector
     * @param type the type of message to post on change
     * @param getValue an optional special function to get the value (default is to return the changed attribute value)
     */
    function watchAttr(attrs, selector, type, getValue) {
      var element = $(selector).get(0);
      if (element) {
        if (getValue == undefined) {
          getValue = function(el, attr) {return el.getAttribute(attr)};
        }
        var observer = new MutationObserver(function (mutations) {
          mutations.forEach(function(mutation) {
            post(type, getValue(mutation.target, mutation.attributeName));
          });
        });
        observers.push(observer);
        observer.observe(element, { attributes: true, attributeFilter: attrs.split(" ") });
        post(type, getValue(element, attrs));//trigger once to initialize the info
      } else {
        console.error("element does not exist (did Google change their site?): " + selector);
      }
    }
    
    executeAfterContentLoad(sendSong, "#time_container_duration, #playerSongInfo", 500);
    executeAfterContentLoad(sendPosition, "#time_container_current", 0);
    executeAfterContentLoad(mainLoaded, "#main", 500);
    watchAttr("class disabled", "#player > div.player-middle > button[data-id='play-pause']", "player-playing", playingGetter);
    watchAttr("value", "#player > div.player-middle > button[data-id='repeat']", "player-repeat");
    watchAttr("value", "#player > div.player-middle > button[data-id='shuffle']", "player-shuffle");
    watchAttr("class", "#player-right-wrapper > .player-rating-container ul.rating-container li", "song-rating", ratingGetter);
    watchAttr("aria-valuenow", "#vslider", "player-volume");
    
    $("#main").on("DOMSubtreeModified", ".song-row td[data-col='rating']", function() {
      if (listRatings) {
        var rating = parseRating(this.dataset.rating);
        var index = $.inArray(this.parentNode, this.parentNode.parentNode.children);
        if (listRatings[index] != rating) {
          listRatings[index] = rating;
          post("player-listrating", {index: index, rating: rating, controlLink: location.hash});
        }
      }
    });
    $(window).on("hashchange", function() { listRatings = null; });
    
    //we must add this script to the DOM for the code to be executed in the correct context
    var injected = document.createElement('script'); injected.type = 'text/javascript';
    injected.src = chrome.extension.getURL('js/injected.js');
    document.getElementsByTagName('head')[0].appendChild(injected);
    window.addEventListener("message", onMessage);
    
    //inject icon with title to mark the tab as connected
    $(".music-banner-icon")
      .css({background: 'url(' + chrome.extension.getURL('img/icon-tabconnected.png') + ')', cursor: "pointer"})
      .attr('title', chrome.i18n.getMessage('connected'))
      .click(function() {
        port.disconnect();
        cleanup();
      });
    
    sendQuickLinks();
  }
  
  function onMessage(event) {
    // We only accept messages from the injected script
    if (event.source != window || event.data.type != "FROM_PRIMEPLAYER_INJECTED") return;
    switch (event.data.msg) {
      case "playlistSongRated":
        var row = $("#main .song-row").get(event.data.index);
        $(row).find("td[data-col='rating']").trigger("DOMSubtreeModified");
        break;
    }
  }
  
  /** Send a command to the injected script. */
  function sendCommand(command, options) {
    window.postMessage({ type: "FROM_PRIMEPLAYER", command: command, options: options }, location.href);
  }
  
  /** remove all listeners/observers and revert DOM modifications */
  function cleanup() {
    sendCommand("cleanup");
    for (var i = 0; i < registeredListeners.length; i++) {
      var l = registeredListeners[i];
      $(l.selector).off("DOMSubtreeModified", l.listener);
    }
    $("#main").off("DOMSubtreeModified");
    $(window).off("hashchange");
    for (var i = 0; i < observers.length; i++) {
      observers[i].disconnect();
    }
    $(".music-banner-icon").removeAttr("style").removeAttr("title").off("click");
    port = null;
  }
  
  function clickListCard(listId) {
    var found = $(".card[data-id='" + listId + "'][data-type='st']").length > 0;
    if (found) {
      contentLoadDestination = "#/ap/queue";
      sendCommand("clickCard", {id: listId});
    }
    return found;
  }
  
  /** Set the hash to the given value to navigate to another page and call the function when finished. */
  function selectAndExecute(hash, callback) {
    if (location.hash == "#/" + hash) {//we're already here
      callback();
    } else {
      executeOnContentLoad = callback;
      contentLoadDestination = null;
      if (hash.indexOf("st/") == 0) {//setting hash does not work for type "st"
        var listId = hash.substr(3);
        if (!clickListCard(listId)) {
          selectAndExecute("rd", function() {//try to find it on the mixes page
            executeOnContentLoad = callback;//set again (was overwritten by the recursive call)
            if (!clickListCard(listId)) {//still not found
              executeOnContentLoad = null;
              callback(true);
            }
          });
        }
      } else {
        location.hash = "/" + hash;
      }
    }
  }
  
  function forHash(text) {
    return encodeURIComponent(text).replace(/%20/g, "+");
  }
  
  var parseNavigationList = {
    playlistsList: function(omitUnknownAlbums) {
      var playlists = [];
      $(".card").each(function() {
        var card = $(this);
        var item = {};
        var id = card.data("id");
        if (omitUnknownAlbums && id.charAt(id.length - 1) == "/") return;
        item.cover = parseCover(card.find(".image-wrapper img"));
        item.title = $.trim(card.find(".title").text());
        item.titleLink = getLink(card);
        var subTitle = card.find(".sub-title");
        item.subTitle = $.trim(subTitle.text());
        item.subTitleLink = getLink(subTitle);
        playlists.push(item);
      });
      return playlists;
    },
    playlist: function() {
      var playlist = [];
      listRatings = [];
      $(".song-row").each(function() {
        var song = $(this);
        var item = {};
        var title = song.find("td[data-col='title'] .content");
        item.cover = parseCover(title.find("img"));
        item.title = $.trim(title.text());
        if (song.find(".song-indicator").length > 0) item.current = true;
        item.artist = $.trim(song.find("td[data-col='artist'] .content").text());
        if (item.artist) item.artistLink = "ar/" + forHash(item.artist);
        var album = song.find("td[data-col='album']");
        item.album = $.trim(album.find(".content").text());
        if (item.album) item.albumLink = "al/" + forHash(album.data("album-artist")) + "/" + forHash(item.album);
        var duration = $.trim(song.find("td[data-col='duration']").text());
        if (/^\d\d?(\:\d\d)*$/.test(duration)) item.duration = duration;//no real duration on recommandation page
        item.rating = parseRating(song.find("td[data-col='rating']").data("rating"));
        listRatings.push(item.rating);
        playlist.push(item);
      });
      return playlist;
    },
    albumContainers: function() {
      var items = [];
      $(".card").each(function() {
        var card = $(this);
        var item = {};
        var img = card.find(".image-inner-wrapper img:first");
        if (img.attr("src").indexOf("/default_artist.png") < 0) item.cover = parseCover(img);
        item.title = $.trim(card.find(".details .title").text());
        item.link = getLink(card);
        items.push(item);
      });
      return items;
    }
  };
  
  function sendMyPlaylists() {
    var playlists = [];
    $("#playlists").children("li").each(function() {
      playlists.push({title: $.trim($(this).find(".tooltip").text()), titleLink: getLink($(this))});
    });
    post("player-navigationList", {type: "playlistsList", link: "myPlaylists", list: playlists});
  }
  
  function sendNavigationList(link, omitUnknownAlbums) {
    selectAndExecute(link, function(error) {
      var response = {link: link, list: [], controlLink: location.hash};
      if (error) {
        response.error = true;
      } else {
        var type = getListType(link);
        //check if we are on a page with correct type
        //e.g. in recommendations list the album link might not work in which case we get redirected to albums page
        if (type == getListType(location.hash.substr(2))) {
          response.type = type;
          response.list = parseNavigationList[type](omitUnknownAlbums);
        } else {
          response.error = true;
        }
      }
      post("player-navigationList", response);
    });
  }
  
  function getListType(hash) {
    var i = hash.indexOf("/");
    if (i > 0) hash = hash.substring(0, i);
    switch (hash) {
      case "artists":
      case "genres":
        return "albumContainers";
      case "now":
      case "albums":
      case "rd":
      case "ar":
      case "sar":
      case "tg":
        return "playlistsList";
      default:
        return "playlist";
    }
  }
  
  port = chrome.runtime.connect({name: "googlemusic"});
  port.onDisconnect.addListener(cleanup);
  port.onMessage.addListener(function(msg) {
    switch (msg.type) {
      case "execute":
        sendCommand(msg.command, msg.options);
        break;
      case "getNavigationList":
        if (msg.link == "myPlaylists") {
          sendMyPlaylists();
        } else {
          sendNavigationList(msg.link, msg.omitUnknownAlbums);
        }
        break;
      case "startPlaylist":
        selectAndExecute(msg.link, function(error) {
          //type "im"/"st" starts automatically
          if (!error && msg.link.indexOf("im/") != 0 && msg.link.indexOf("st/") != 0) sendCommand("startPlaylist");
        });
        break;
      case "connected":
        init();
        break;
      case "alreadyConnected":
        port.disconnect();
        port = null;
        break;
    }
  });
});
