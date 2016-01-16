"use strict";
var Firebase = require('firebase');
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = fbCollections = {
    reviews: function (baseUrl) {
        var ref = new Firebase(baseUrl);
        return new Firebase.util.NormalizedCollection(ref.child('reviews'), [ref.child('users').child('public'), 'user', 'reviews.userId'], [ref.child('products'), 'product', 'reviews.productId']).select('reviews.reviews', 'reviews.userId', 'user.firstName', 'user.lastName', 'reviews.productId', { key: 'product.name', alias: 'productName' }).ref();
    }
};
