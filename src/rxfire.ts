/// <reference path="../../typings/tsd.d.ts" />

import Rx from 'rx'
import Firebase from 'firebase'
import fbCollections from './firebase-collections'

function checkRef(opts: RxFireOptions) {
  let ref = opts && (opts.ref || opts.fbRef)
            || typeof opts === 'string' && opts || this.base
  ref = opts.ref.includes('firebaseio.com') ? ref : this.base + '/' + ref
  return ref
}

export default class RxFire extends Firebase {
  base: string

  initialItems = []
  newItems= new Rx.Subject()
  list = new Rx.ReplaySubject(1)
  updates = new Rx.Subject()
  create = new Rx.Subject()

  constructor(opts: RxFireOptions) {
    super(checkRef(opts))
    // let   ref             = opts && (opts.ref || opts.fbRef) ||
    //                         typeof opts === 'string' && opts || this.base
    //
    // ref = opts.ref.includes('firebaseio.com') ? ref : this.base + '/' + ref
    // super(ref)

    const onChildAdded    = opts && opts.initChildAdded      || true
    const normalized      = opts && opts.normalized          || false
    const onValue         = opts && opts.onValue             || false
    const orderByChild    = opts && opts.orderByChild        || false
    const equalTo         = opts && opts.equalTo             || false

    this.ref = normalized ? this.normalizedCollection(normalized) : this

    if (onValue) {
      this.onValue()
    } else if (onChildAdded && !onValue) {
      this.onChildAdded()
    }
  }

  static setBase(baseUrl: string) {
    RxFire.prototype.base = baseUrl
  }

  onValue() {
    this.ref.on('value', snap => this.list.next(snap.val()))
  }

  onChildAdded() {
    this.updates
      .scan((childAdded, operation) => operation(childAdded), this.initialItems)
      .subscribe(this.list)

    this.create
      .map(item => childAdded => childAdded.concat(item))
      .subscribe(this.updates)

    this.newItems
      .subscribe(this.create)

    this.ref.on('child_added', snap => this.newItems.next(snap.val()))
  }

  normalizedCollection(collectionId) {
    return fbCollections[collectionId](this.base)
  }
}
