/// <reference path="../../typings/tsd.d.ts" />
var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var rx_1 = require('rx');
var firebase_1 = require('firebase');
var firebase_collections_1 = require('./firebase-collections');
function checkRef(opts) {
    var ref = opts && (opts.ref || opts.fbRef)
        || typeof opts === 'string' && opts || this.base;
    ref = opts.ref.includes('firebaseio.com') ? ref : this.base + '/' + ref;
    return ref;
}
var RxFire = (function (_super) {
    __extends(RxFire, _super);
    function RxFire(opts) {
        _super.call(this, checkRef(opts));
        this.initialItems = [];
        this.newItems = new rx_1.default.Subject();
        this.list = new rx_1.default.ReplaySubject(1);
        this.updates = new rx_1.default.Subject();
        this.create = new rx_1.default.Subject();
        var onChildAdded = opts && opts.initChildAdded || true;
        var normalized = opts && opts.normalized || false;
        var onValue = opts && opts.onValue || false;
        var orderByChild = opts && opts.orderByChild || false;
        var equalTo = opts && opts.equalTo || false;
        this.ref = normalized ? this.normalizedCollection(normalized) : this;
        if (onValue) {
            this.onValue();
        }
        else if (onChildAdded && !onValue) {
            this.onChildAdded();
        }
    }
    RxFire.setBase = function (baseUrl) {
        RxFire.prototype.base = baseUrl;
    };
    RxFire.prototype.onValue = function () {
        var _this = this;
        this.ref.on('value', function (snap) { return _this.list.next(snap.val()); });
    };
    RxFire.prototype.onChildAdded = function () {
        var _this = this;
        this.updates
            .scan(function (childAdded, operation) { return operation(childAdded); }, this.initialItems)
            .subscribe(this.list);
        this.create
            .map(function (item) { return function (childAdded) { return childAdded.concat(item); }; })
            .subscribe(this.updates);
        this.newItems
            .subscribe(this.create);
        this.ref.on('child_added', function (snap) { return _this.newItems.next(snap.val()); });
    };
    RxFire.prototype.normalizedCollection = function (collectionId) {
        return firebase_collections_1.default[collectionId](this.base);
    };
    return RxFire;
})(firebase_1.default);
exports.default = RxFire;
