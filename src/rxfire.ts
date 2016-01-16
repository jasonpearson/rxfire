/// <reference path="../typings/tsd.d.ts" />

import Rx = require('rx')
import Firebase = require('firebase')
import fbCollections from './firebase-collections'
import Assign = require('lodash.assign')

function checkRef(opts: RxFireOptions) {
  const instanceRef = opts && (opts.ref || opts.fbRef)
  if (opts.normalized) {
    return RxFire.base
  } else {
    return RxFire.base ? RxFire.base + '/' + instanceRef : opts.ref || opts.fbRef
  }
}

export default class RxFire extends Firebase {
  static base: string
  initialItems = []
  newItems= new Rx.Subject()
  list = new Rx.ReplaySubject(1)
  updates = new Rx.Subject()
  create = new Rx.Subject()

  constructor(opts: RxFireOptions) {
    super(checkRef(opts))
    const onChildAdded    = opts && opts.initChildAdded      || true
    const normalized      = opts && opts.normalized          || ''
    const onValue         = opts && opts.onValue             || false
    const orderByChild    = opts && opts.orderByChild        || false
    const equalTo         = opts && opts.equalTo             || false

    if (normalized && onValue) {
      this.listenOnValue.call( RxFire.normalizedRef(this, RxFire.base, normalized) )
    } else if (normalized && onChildAdded && !onValue) {
      this.listenOnChildAdded.call( RxFire.normalizedRef(this, RxFire.base, normalized) )
    } else if (onValue) {
      this.listenOnValue()
    } else if (onChildAdded && !onValue) {
      this.listenOnChildAdded()
    }
  }

  static setBase(baseUrl: string) {
    RxFire.base = baseUrl
  }

  listenOnValue() {
    this.on('value', snap => this.list.next(snap.val()))
  }

  listenOnChildAdded() {
    this.updates
      .scan((childAdded, operation) => operation(childAdded), this.initialItems)
      .subscribe(this.list)

    this.create
      .map(item => childAdded => childAdded.concat(item))
      .subscribe(this.updates)

    this.newItems
      .subscribe(this.create)

    this.on('child_added', snap => this.newItems.next(snap.val()))
  }

  static normalizedRef(instance: RxFire, ref: string, collectionId: string) {
    var normRef = Assign( instance, fbCollections[collectionId](ref) )
    return normRef
  }
}
