define(
  [
    'wbxml',
    'activesync/codepages',
    'activesync/protocol',
    'mimelib',
    './quotechew',
    './util',
    'exports'
  ],
  function(
    $wbxml,
    $ascp,
    $activesync,
    $mimelib,
    $quotechew,
    $util,
    exports
  ) {
'use strict';

function ActiveSyncFolderStorage(account, folderInfo, dbConn) {
  this.account = account;
  this._db = dbConn;

  this.folderId = folderInfo.$meta.id;
  this.serverId = folderInfo.$meta.serverId;
  this.folderMeta = folderInfo.$meta;
  if (!this.folderMeta.syncKey)
    this.folderMeta.syncKey = '0';

  this._headers = [];
  this._bodiesBySuid = {};

  this._onLoadHeaderListeners = [];
  this._onLoadBodyListeners = [];

  let self = this;

  this._db.loadHeaderBlock(this.folderId, 0, function(block) {
    self._loadedHeaders = true;
    if (block)
      self._headers = block;

    for (let [,listener] in Iterator(self._onLoadHeaderListeners))
      listener();
  });

  this._db.loadBodyBlock(this.folderId, 0, function(block) {
    self._loadedBodies = true;
    if (block)
      self._bodiesBySuid = block;

    for (let [,listener] in Iterator(self._onLoadBodyListeners))
      listener();
  });
}
exports.ActiveSyncFolderStorage = ActiveSyncFolderStorage;
ActiveSyncFolderStorage.prototype = {
  generatePersistenceInfo: function asfs_generatePersistenceInfo() {
    return {
      id: this.folderId,
      headerBlocks: [ this._headers ],
      bodyBlocks:   [ this._bodiesBySuid ],
    };
  },

  _getSyncKey: function asfs__getSyncKey(callback) {
    let folderStorage = this;
    let account = this.account;
    let as = $ascp.AirSync.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection)

    if (account.conn.currentVersionInt < $activesync.VersionInt('12.1'))
          w.tag(as.Class, 'Email');

          w.tag(as.SyncKey, '0')
           .tag(as.CollectionId, this.serverId)
         .etag()
       .etag()
     .etag();

    account.conn.doCommand(w, function(aError, aResponse) {
      if (aError)
        return;

      let e = new $wbxml.EventParser();
      e.addEventListener([as.Sync, as.Collections, as.Collection, as.SyncKey],
                         function(node) {
        folderStorage.folderMeta.syncKey = node.children[0].textContent;
      });
      e.run(aResponse);

      callback();
    });
  },

  _loadMessages: function asfs__loadMessages(callback, deferred) {
    let folderStorage = this;
    let account = this.account;

    if (!account.conn.connected) {
      account.conn.autodiscover(function(config) {
        // TODO: handle errors
        folderStorage._loadMessages(callback, deferred);
      });
      return;
    }
    if (this.folderMeta.syncKey === '0' && !deferred) {
      this._getSyncKey(this._loadMessages.bind(this, callback, true));
      return;
    }

    let as = $ascp.AirSync.Tags;
    let asb = $ascp.AirSyncBase.Tags;

    let w = new $wbxml.Writer('1.3', 1, 'UTF-8');
    w.stag(as.Sync)
       .stag(as.Collections)
         .stag(as.Collection);

    if (account.conn.currentVersionInt < $activesync.VersionInt('12.1'))
          w.tag(as.Class, 'Email');

          w.tag(as.SyncKey, this.folderMeta.syncKey)
           .tag(as.CollectionId, this.serverId)
           .tag(as.GetChanges)
           .stag(as.Options)

    if (account.conn.currentVersionInt >= $activesync.VersionInt('12.0'))
            w.stag(asb.BodyPreference)
               .tag(asb.Type, '1')
             .etag();

            w.tag(as.MIMESupport, '2')
             .tag(as.MIMETruncation, '7')
           .etag()
         .etag()
       .etag()
     .etag();

    account.conn.doCommand(w, function(aError, aResponse) {
      let added   = { headers: [], bodies: {} };
      let changed = { headers: [], bodies: {} };
      let deleted = [];
      let status;

      if (aError)
        return;
      if (!aResponse) {
        callback(added, changed, deleted);
        return;
      }

      let e = new $wbxml.EventParser();
      const base = [as.Sync, as.Collections, as.Collection];

      e.addEventListener(base.concat(as.Status), function(node) {
        status = node.children[0].textContent;
      });

      e.addEventListener(base.concat(as.SyncKey), function(node) {
        folderStorage.folderMeta.syncKey = node.children[0].textContent;
      });

      e.addEventListener(base.concat(as.Commands, [[as.Add, as.Change]]),
                         function(node) {
        let guid;
        let msg;

        for (let [,child] in Iterator(node.children)) {
          switch (child.tag) {
          case as.ServerId:
            guid = child.children[0].textContent;
            break;
          case as.ApplicationData:
            msg = folderStorage._processMessage(child, node.tag === as.Add);
            break;
          }
        }

        msg.headers.guid = guid;
        msg.headers.suid = folderStorage.folderId + '/' + guid;

        let collection = node.tag === as.Add ? added : changed;
        collection.headers.push(msg.headers);
        collection.bodies[msg.headers.suid] = msg.body;
      });

      e.addEventListener(base.concat(as.Commands, as.Delete), function(node) {
        let guid;

        for (let [,child] in Iterator(node.children)) {
          switch (child.tag) {
          case as.ServerId:
            guid = child.children[0].textContent;
            break;
          }
        }

        deleted.push(guid);
      });

      e.run(aResponse);

      if (status === '1') { // Success
        callback(added, changed, deleted);
      }
      else if (status === '3') { // Bad sync key
        console.log('ActiveSync had a bad sync key');
        // This should already be set to 0, but let's just be safe.
        folderStorage.folderMeta.syncKey = '0';
        folderStorage._needsPurge = true;
        folderStorage._loadMessages(callback);
      }
      else {
        console.error('Something went wrong during ActiveSync syncing and we ' +
                      'got a status of ' + status);
      }
    });
  },

  _processMessage: function asfs__processMessage(node, isAdded) {
    let asb = $ascp.AirSyncBase.Tags;
    let em = $ascp.Email.Tags;
    let headers, body, flagHeader;

    if (isAdded) {
      headers = {
        id: null,
        suid: null,
        guid: null,
        author: null,
        date: null,
        flags: [],
        hasAttachments: null,
        subject: null,
        snippet: null,
      };

      body = {
        date: null,
        size: null,
        to: null,
        cc: null,
        bcc: null,
        replyTo: null,
        attachments: [],
        references: null,
        bodyRep: null,
      };

      flagHeader = function(flag, state) {
        if (state)
          headers.flags.push(flag);
      }
    }
    else {
      headers = {
        flags: [],
        mergeInto: function(o) {
          // Merge flags
          for (let [,flagstate] in Iterator(this.flags)) {
            if (flagstate[1]) {
              o.flags.push(flagstate[0]);
            }
            else {
              let index = o.flags.indexOf(flagstate[0]);
              if (index !== -1)
                o.flags.splice(index, 1);
            }
          }

          // Merge everything else
          for (let [key, value] in Iterator(this)) {
            if (['mergeInto', 'suid', 'guid', 'flags'].indexOf(key) !== -1)
              continue;

            o[key] = value;
          }
        },
      };

      body = {
        mergeInto: function(o) {
          for (let [key, value] in Iterator(this)) {
            if (key === 'mergeInto') continue;
            o[key] = value;
          }
        },
      };

      flagHeader = function(flag, state) {
        headers.flags.push([flag, state]);
      }
    }

    for (let [,child] in Iterator(node.children)) {
      let childText = child.children.length &&
                      child.children[0].textContent;

      switch (child.tag) {
      case em.Subject:
        headers.subject = childText;
        break;
      case em.From:
        headers.author = $mimelib.parseAddresses(childText)[0];
        break;
      case em.To:
        body.to = $mimelib.parseAddresses(childText);
        break;
      case em.Cc:
        body.cc = $mimelib.parseAddresses(childText);
        break;
      case em.ReplyTo:
        body.replyTo = $mimelib.parseAddresses(childText);
        break;
      case em.DateReceived:
        body.date = headers.date = new Date(childText).valueOf();
        break;
      case em.Read:
        flagHeader('\\Seen', childText === '1');
        break;
      case em.Flag:
        for (let [,grandchild] in Iterator(child.children)) {
          if (grandchild.tag === em.Status)
            flagHeader('\\Flagged', grandchild.children[0].textContent !== '0');
        }
        break;
      case asb.Body: // ActiveSync 12.0+
        for (let [,grandchild] in Iterator(child.children)) {
          if (grandchild.tag === asb.Data) {
            body.bodyRep = $quotechew.quoteProcessTextBody(
              grandchild.children[0].textContent);
            headers.snippet = $quotechew.generateSnippet(body.bodyRep);
          }
        }
        break;
      case em.Body: // pre-ActiveSync 12.0
        body.bodyRep = $quotechew.quoteProcessTextBody(childText);
        headers.snippet = $quotechew.generateSnippet(body.bodyRep);
        break;
      case asb.Attachments: // ActiveSync 12.0+
      case em.Attachments:  // pre-ActiveSync 12.0
        headers.hasAttachments = true;
        body.attachments = [];
        for (let [,attachmentNode] in Iterator(child.children)) {
          if (attachmentNode.tag !== asb.Attachment &&
              attachmentNode.tag !== em.Attachment)
            continue; // XXX: throw an error here??

          let attachment = { type: 'text/plain' }; // XXX: this is lies
          for (let [,attachData] in Iterator(attachmentNode.children)) {
            switch (attachData.tag) {
            case asb.DisplayName:
            case em.DisplayName:
              attachment.name = attachData.children[0].textContent;
              break;
            case asb.EstimatedDataSize:
            case em.AttSize:
              attachment.sizeEstimate = attachData.children[0].textContent;
              break;
            }
          }
          body.attachments.push(attachment);
        }
        break;
      }
    }

    return { headers: headers, body: body };
  },

  _sliceFolderMessages: function asfs__sliceFolderMessages(bridgeHandle) {
    if (!this._loadedHeaders) {
      this._onLoadHeaderListeners.push(this._sliceFolderMessages
                                           .bind(this, bridgeHandle));
      return;
    }

    this._bridgeHandle = bridgeHandle;
    bridgeHandle.sendSplice(0, 0, this._headers, true, true);

    var folderStorage = this;
    this._loadMessages(function(added, changed, deleted) {
      if (folderStorage._needsPurge) {
        bridgeHandle.sendSplice(0, folderStorage._headers.length, [], false,
                                true);
        folderStorage._headers = [];
        folderStorage._bodiesBySuid = {};
        folderStorage._needsPurge = false;
      }

      // Handle messages that have been deleted
      for (let [,guid] in Iterator(deleted)) {
        for (let [i, header] in Iterator(folderStorage._headers)) {
          if (header.guid === guid) {
            delete folderStorage._bodiesBySuid[header.suid];
            folderStorage._headers.splice(i, 1);
            bridgeHandle.sendSplice(i, 1, [], true, true);
            break;
          }
        }
      }

      // Handle messages that have been changed
      for (let [,newHeader] in Iterator(changed.headers)) {
        for (let [i, oldHeader] in Iterator(folderStorage._headers)) {
          if (oldHeader.guid === newHeader.guid) {
            let oldBody = folderStorage._bodiesBySuid[oldHeader.suid];
            let newBody = changed.bodies[oldHeader.suid];

            newHeader.mergeInto(oldHeader);
            newBody.mergeInto(oldBody);
            bridgeHandle.sendUpdate([i, oldHeader]);

            break;
          }
        }
      }

      // Handle messages that have been added
      if (added.headers.length) {
        added.headers.sort(function(a, b) b.date - a.date);
        let addedBlocks = {};
        for (let [,header] in Iterator(added.headers)) {
          let idx = $util.bsearchForInsert(folderStorage._headers, header,
                                           function(a, b) b.date - a.date);
          if (!(idx in addedBlocks))
            addedBlocks[idx] = [];
          addedBlocks[idx].push(header);
        }

        let keys = Object.keys(addedBlocks).sort(function(a, b) b - a);
        let hdrs = folderStorage._headers;
        for (let [,key] in Iterator(keys)) {
          // XXX: I feel like this is probably slower than it needs to be...
          hdrs.splice.apply(hdrs, [key, 0].concat(addedBlocks[key]));
          bridgeHandle.sendSplice(key, 0, addedBlocks[key], true, true);
        }

        for (let [k, v] in Iterator(added.bodies))
          folderStorage._bodiesBySuid[k] = v;
      }

      bridgeHandle.sendStatus(true, false);
      folderStorage.account.saveAccountState();
    });
  },

  getMessageBody: function asfs_getMessageBody(suid, date, callback) {
    if (!this._loadedBodies) {
      this._onLoadBodyListeners.push(this.getMessageBody.bind(this, suid, date,
                                                              callback));
      return;
    }

    callback(this._bodiesBySuid[suid]);
  },
};

}); // end define
