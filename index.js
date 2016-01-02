import Rx from 'rxjs'
import Firebase from 'firebase'
import fbCollections from './firebase-collections'

export default class RxFire extends Firebase {
  base: string
  initialItems = []
  newItems= new Rx.Subject()
  list = new Rx.ReplaySubject(1)
  updates = new Rx.Subject()
  create = new Rx.Subject()

  constructor(opts) {
    let   ref             = opts && (opts.ref || opts.fbRef) ||
                            typeof opts === 'string' && opts || this.base
    const onChildAdded    = opts && opts.initChildAdded      || true
    const normalized      = opts && opts.normalized          || false
    const onValue         = opts && opts.onValue             || false
    const orderByChild    = opts && opts.orderByChild        || false
    const equalTo         = opts && opts.equalTo             || false

    ref = ref.includes('firebaseio.com') ? ref : this.base + '/' + ref
    super(ref)
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
