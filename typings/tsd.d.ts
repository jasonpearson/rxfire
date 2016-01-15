/// <reference path="firebase/firebase.d.ts" />
/// <reference path="rx/rx-lite.d.ts" />
/// <reference path="rx/rx.d.ts" />

interface RxFireOptions {
  ref?: string;
  fbRef?: string;
  initChildAdded?: boolean;
  normalized?: boolean;
  onValue?: boolean;
  orderByChild?: boolean;
  equalTo?: boolean;
}
