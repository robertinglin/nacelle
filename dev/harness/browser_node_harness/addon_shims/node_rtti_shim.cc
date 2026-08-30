// libnode link shim for wasm32 addon builds.
//
// Real Node links addons against libnode, so addons may reference libnode's
// RTTI identity (typeinfo/vtable for node::AsyncResource and friends). The
// browser runtime supplies the *behavior* through wasm imports; only type
// identity needs an object-level definition. Defining the key function
// (~AsyncResource) emits the typeinfo and vtable the linker wants.
#include <node.h>

namespace node {

AsyncResource::~AsyncResource() {}

}  // namespace node
