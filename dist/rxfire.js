"use strict";
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var Rx = require('rx');
var Firebase = require('firebase');
var firebase_collections_1 = require('./firebase-collections');
var Assign = require('lodash.assign');
function checkRef(opts) {
    var instanceRef = opts && (opts.ref || opts.fbRef);
    if (opts.normalized) {
        return RxFire.base;
    }
    else {
        return RxFire.base ? RxFire.base + '/' + instanceRef : opts.ref || opts.fbRef;
    }
}
var RxFire = (function (_super) {
    __extends(RxFire, _super);
    function RxFire(opts) {
        _super.call(this, checkRef(opts));
        this.initialItems = [];
        this.newItems = new Rx.Subject();
        this.list = new Rx.ReplaySubject(1);
        this.updates = new Rx.Subject();
        this.create = new Rx.Subject();
        var onChildAdded = opts && opts.initChildAdded || true;
        var normalized = opts && opts.normalized || '';
        var onValue = opts && opts.onValue || false;
        var orderByChild = opts && opts.orderByChild || false;
        var equalTo = opts && opts.equalTo || false;
        if (normalized && onValue) {
            this.listenOnValue.call(RxFire.normalizedRef(this, RxFire.base, normalized));
        }
        else if (normalized && onChildAdded && !onValue) {
            this.listenOnChildAdded.call(RxFire.normalizedRef(this, RxFire.base, normalized));
        }
        else if (onValue) {
            this.listenOnValue();
        }
        else if (onChildAdded && !onValue) {
            this.listenOnChildAdded();
        }
    }
    RxFire.setBase = function (baseUrl) {
        RxFire.base = baseUrl;
    };
    RxFire.prototype.listenOnValue = function () {
        var _this = this;
        this.on('value', function (snap) { return _this.list.next(snap.val()); });
    };
    RxFire.prototype.listenOnChildAdded = function () {
        var _this = this;
        this.updates
            .scan(function (childAdded, operation) { return operation(childAdded); }, this.initialItems)
            .subscribe(this.list);
        this.create
            .map(function (item) { return function (childAdded) { return childAdded.concat(item); }; })
            .subscribe(this.updates);
        this.newItems
            .subscribe(this.create);
        this.on('child_added', function (snap) { return _this.newItems.next(snap.val()); });
    };
    RxFire.normalizedRef = function (instance, ref, collectionId) {
        var normRef = Assign(instance, firebase_collections_1.default[collectionId](ref));
        return normRef;
    };
    return RxFire;
}(Firebase));
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = RxFire;
