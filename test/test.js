import RxFire from '../src/rxfire'
// var RxFire = require('../dist/rxfire.js').RxFire

RxFire.setBase('https://jsonperson.firebaseio.com')

var rxFire = new RxFire({
  ref: 'products'
})

rxFire.list.subscribe(items => console.log(items))
