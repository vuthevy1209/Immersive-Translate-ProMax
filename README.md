# ProMax Translate

Extension Chrome dịch song ngữ **theo từng câu**: bản dịch hiện ngay dưới mỗi câu gốc, thay vì dịch cả đoạn thành một cục như Immersive Translate.

```
Regional collectors eager to acquire ... at this year's Annual Melbourne Art Auction.
Các nhà sưu tập trong khu vực mong muốn ... năm nay.          ← chữ nâu cam
Celebrating its 30th year, organizers of this year's event have gathered ...
Kỷ niệm 30 năm thành lập, những người tổ chức sự kiện ...
```

## Cài đặt

1. Mở `chrome://extensions`
2. Bật **Developer mode** (góc trên bên phải)
3. Bấm **Load unpacked** rồi chọn thư mục này (`Immersive-Translate-ProMax`)
4. Ghim icon ProMax lên thanh công cụ cho tiện

Sau khi sửa code, bấm nút ↻ trên thẻ extension ở `chrome://extensions` rồi tải lại trang đang đọc.

## Sử dụng

- **Con bot hình ngôi sao** nổi ở góc phải trang: bấm vào để dịch trang, bấm lần nữa để tắt. Logo **đen** là chưa dịch, **cam** là đang dịch (xoay khi đang chờ Google). Kéo thả để đặt bot ở đâu cũng được; vị trí được nhớ cho mọi trang.
- **Phím tắt `Alt+S`** (trên Mac là `⌥S`) cũng bật/tắt dịch. Đổi phím tắt tại `chrome://extensions/shortcuts`.
- **Popup** trên thanh extension (icon Claude Code): nút Dịch trang và hai công tắc. Hiện chỉ dịch sang tiếng Việt.
  - **Bấm để highlight**: bấm vào một cụm (mỗi cụm kết thúc bằng dấu phẩy hoặc chấm phẩy) ở câu gốc hay ở bản dịch thì cụm đó và phần dịch tương ứng cùng được tô cam nhạt. Bấm cụm khác để chuyển, bấm ra ngoài để tắt.
  - **Bôi đen để dịch** (giống DiDict), dùng được trên mọi trang kể cả khi không bật dịch. Bôi đen một từ thì hiện phiên âm, nút nghe phát âm, bản dịch, nghĩa tiếng Việt theo từ loại, định nghĩa và ví dụ tiếng Anh. Bôi đen cả cụm hay cả câu thì hiện bản dịch. Kéo hàng tiêu đề của popup để di chuyển nó. Bấm ra ngoài hoặc nhấn `Esc` để đóng.
  - **Nút Obsidian** trong popup (cạnh nút loa): thêm dòng `- **từ**: nghĩa` vào **cuối note đang mở trong Obsidian**. Thêm xong nút hiện dấu ✓ trong 1 giây rồi trở lại, bấm lần nữa là thêm lần nữa. Không thêm được (Obsidian chưa mở, chưa mở note nào, hoặc note đang ở chế độ đọc) thì hiện dấu ✗ đỏ kèm lý do. Thẻ `[!vocab]` đầy đủ thì dựng sau bằng skill `vocab-illustrate`. Cần mở Obsidian và bật plugin Vocab Flashcard (plugin nhận dữ liệu ở `127.0.0.1:27190`, chỉ nhận từ extension).
- **Phụ đề song ngữ trên YouTube và Udemy** (công tắc *Phụ đề song ngữ* trong popup, bật sẵn): cứ bật phụ đề của video như bình thường, bản dịch hiện ngay dưới từng dòng phụ đề. Không cần bấm nút dịch trang.
  - **YouTube**: extension tự vẽ phụ đề (dòng gốc trắng, dòng dịch cam nhạt) và ẩn phụ đề gốc của YouTube. Phụ đề tự động (auto-generated) vốn hiện từng chữ được gom lại thành từng dòng trọn vẹn. Đổi ngôn ngữ phụ đề trong YouTube thì bản dịch đổi theo. Bôi đen chữ trong phụ đề để tra từ mà video không bị dừng.
  - **Udemy**: bản dịch nằm ngay trong khung phụ đề của Udemy, theo cỡ chữ và độ mờ bạn chỉnh trong Caption settings. Ở chế độ phóng to (phụ đề nằm trong dải tối dưới video) mà dải không đủ chỗ cho dòng dịch, dòng dịch nổi ngay phía trên dải. Phụ đề Udemy giờ bôi đen được để tra từ.
  - Full màn hình: phụ đề song ngữ và popup tra từ khi bôi đen đều hiện bình thường.
  - Ngay khi player tải file phụ đề, extension dịch **cả file** luôn, bắt đầu từ đoạn video đang phát rồi đến hết, sau đó quay lại phần đầu. Video 1 tiếng dịch xong trong khoảng 10 giây, nên khi xem thì dòng nào cũng đã có bản dịch sẵn. Trên YouTube, lúc đang dịch có dòng nhỏ *Đang dịch phụ đề… 35%* phía trên phụ đề. Tua đi đâu thì đoạn đó được dịch trước.
  - Mỗi lần dịch một câu trọn vẹn (kể cả khi câu vắt qua nhiều dòng), rồi chia bản dịch về đúng từng dòng.
- Tắt dịch sẽ gỡ sạch bản dịch và trả trang về nguyên trạng.

## Cách hoạt động

| File | Việc |
|---|---|
| `src/segment.js` | Tách câu bằng `Intl.Segmenter` của Chrome, cộng thêm luật cho `Mr.`, `Dr.`, `U.S.`, `J. K.`, `"Done?" she asked`... Tách tiếp mỗi câu thành cụm theo `,` và `;` (bỏ qua số như `$2,500` và phần trong ngoặc). Bỏ qua câu không cần dịch (số, URL, câu đã là tiếng Việt). |
| `src/content.js` | Tìm các khối chứa chữ (p, li, td, div...), tách theo `<br>`, tách câu, rồi chèn `<ipm-translation>` ngay sau ký tự cuối của mỗi câu (kể cả khi câu vắt qua `<a>`, `<b>`). Chỉ dịch phần đang hiện trên màn hình, gom nhiều câu vào một request, tự dịch phần nội dung trang thêm vào sau. Khi bấm vào một cụm, phía câu gốc được tô bằng CSS Custom Highlight API nên không sửa DOM của trang. |
| `src/translator.js` | Gọi Google Translate (endpoint miễn phí `translate_a/t`, một request nhận nhiều câu). Mỗi câu được gửi dạng `<a i=0>cụm 1,</a> <a i=1>cụm 2</a>`. Google vẫn dịch cả câu có ngữ cảnh, nhưng giữ thẻ quanh phần dịch của từng cụm, nên biết được cụm nào ứng với cụm nào. Tra từ khi bôi đen dùng `translate_a/single` (bản dịch, phiên âm, nghĩa theo từ loại, định nghĩa, ví dụ). Có chỗ để thêm engine khác. |
| `src/subtitle-hook.js` | Chạy trong JavaScript của chính trang (`world: MAIN`) từ `document_start` trên YouTube và Udemy. Chép lại file phụ đề player tải về (YouTube: XHR `/api/timedtext` dạng json3; Udemy: `fetch` file `.vtt`) và chuyển sang `subtitles.js` qua DOM event. |
| `src/subtitle-parse.js` | Đọc WebVTT, json3 (cả phụ đề tự động từng chữ) và XML cũ của YouTube thành các dòng có thời gian, gom dòng thành câu, rồi chia bản dịch của cả câu về từng dòng nhờ thẻ `<a i=k>` của `translator.js`. |
| `src/subtitles.js` | YouTube: vẽ `<ipm-subs>` đè lên video theo `video.currentTime`, ẩn phụ đề gốc. Udemy: chèn `<ipm-sub-tr>` vào khung phụ đề Udemy đang hiện, khớp chữ trên màn hình với file `.vtt`. Nếu không bắt được file phụ đề (vừa cài/tải lại extension mà chưa tải lại trang) thì dịch thẳng chữ phụ đề đang hiện. |
| `src/background.js` | Service worker: nhận yêu cầu dịch, xử lý phím tắt, tự chèn script vào tab đã mở từ trước khi cài extension. |
| `src/popup.*` | Giao diện popup (theme Claude). |

## Test

```bash
node --test test/*.test.mjs
```

`test/demo.html` chạy content script trên một trang thường (không cần cài extension) với nhiều trường hợp khó: câu nằm trong link, `<br>`, list lồng nhau, bảng, flex, ruby, đoạn thêm động, đoạn bị vẽ lại. Mở qua một server local, thêm `?fake` vào URL để không gọi Google:

```bash
python3 -m http.server 8765
```

Sau đó mở `http://localhost:8765/test/demo.html?fake`. `test/plain.html` là trang tĩnh để thử bản extension đã cài. `test/subtitles-demo.html?fake` giả lập player Udemy ở chế độ phóng to (dải phụ đề cao cố định, tên class lạ) để thử phụ đề song ngữ; thêm `&overlay` cho phụ đề đè lên video.

## Giới hạn hiện tại

- Endpoint Google miễn phí là không chính thức, dịch quá nhiều có thể bị chặn tạm thời.
- Trên trang React/SPA, việc tách text node đôi khi làm lệch nội dung khi trang tự cập nhật. Tải lại trang là hết.
- Chưa dịch nội dung trong iframe và shadow DOM.
- Cache chỉ sống trong một lần mở trang.
- Phụ đề song ngữ: sau khi cài hoặc tải lại extension, tải lại trang video để extension bắt được file phụ đề (trước đó vẫn dịch được, nhưng chậm hơn và từng dòng một). Chưa hỗ trợ `m.youtube.com` và YouTube Shorts.

## Hướng phát triển

- Engine LLM (Claude/Gemini): gửi cả đoạn, nhận lại bản dịch từng câu có ngữ cảnh.
- Cache bền vững (`chrome.storage.local`) để mở lại bài cũ không phải dịch lại.
- Click vào câu để ẩn/hiện bản dịch, chế độ "chỉ hiện bản dịch khi hover".
# Immersive-Translate-ProMax
