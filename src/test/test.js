import RxFire from 'rxfire';
// import RxFire from '../src/rxfire'

RxFire.setBase('https://jsonperson.firebaseio.com')

var rxFire = new RxFire({
  ref: 'products'
})

rxFire.list.subscribe(items => console.log(items))
