import Firebase = require('firebase')
import fbUtil = require('firebase-util')

export default fbCollections = {
  reviews: baseUrl => {
    const ref = new Firebase(baseUrl)
    return new Firebase.util.NormalizedCollection(
      ref.child('reviews'),
      [ref.child('users').child('public'), 'user', 'reviews.userId'],
      [ref.child('products'), 'product', 'reviews.productId']
    ).select(
      'reviews.reviews',
      'reviews.userId',
      'user.firstName',
      'user.lastName',
      'reviews.productId',
      {key: 'product.name', alias: 'productName'}
    ).ref()
  }
}
