import RxFire from './index'

RxFire.setBase('https://jsonperson.firebaseio.com')

var rxFire = new RxFire({
  ref: 'products'
})

rxFire.list.subscribe(items => console.log(items))
