add logger message when pausing because of ratelimit.
add logger message when qeueue finishes

curl http://localhost:33001/accounts/3d59ec02a0cfd545/progress isnt showing inven is qd. also include q inven size that is scanning

if item is worth 1> then reqeue in 24 hours
if item is worth 10> then reqeue in 12 hours
everything else over recan every 6 hours
make it so it easy to add a different thresold

add check that item hasnt been scanned since since last time if scan is reran or new inven inlcudes it. say we scan item then new inven with that item is added again well rescan straight away. make sure this doesnt happen. also add option to force scan
