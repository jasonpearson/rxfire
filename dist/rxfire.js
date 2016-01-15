/// <reference path="../typings/tsd.d.ts" />
import fbCollections from './firebase-collections';
function checkRef(opts) {
    let ref = opts && (opts.ref || opts.fbRef)
        || typeof opts === 'string' && opts || this.base;
    ref = opts.ref.includes('firebaseio.com') ? ref : this.base + '/' + ref;
    return ref;
}
export default class RxFire extends Firebase {
    constructor(opts) {
        super(checkRef(opts));
        this.initialItems = [];
        this.newItems = new Rx.Subject();
        this.list = new Rx.ReplaySubject(1);
        this.updates = new Rx.Subject();
        this.create = new Rx.Subject();
        const onChildAdded = opts && opts.initChildAdded || true;
        const normalized = opts && opts.normalized || false;
        const onValue = opts && opts.onValue || false;
        const orderByChild = opts && opts.orderByChild || false;
        const equalTo = opts && opts.equalTo || false;
        this.ref = normalized ? this.normalizedCollection(normalized) : this;
        if (onValue) {
            this.onValue();
        }
        else if (onChildAdded && !onValue) {
            this.onChildAdded();
        }
    }
    static setBase(baseUrl) {
        RxFire.prototype.base = baseUrl;
    }
    onValue() {
        this.ref.on('value', snap => this.list.next(snap.val()));
    }
    onChildAdded() {
        this.updates
            .scan((childAdded, operation) => operation(childAdded), this.initialItems)
            .subscribe(this.list);
        this.create
            .map(item => childAdded => childAdded.concat(item))
            .subscribe(this.updates);
        this.newItems
            .subscribe(this.create);
        this.ref.on('child_added', snap => this.newItems.next(snap.val()));
    }
    normalizedCollection(collectionId) {
        return fbCollections[collectionId](this.base);
    }
}
