# iPhone: Photos → Share → Catch

The fastest capture route. You start where the screenshots already are:

**Photos → select screenshots → Share → Catch → talk → tap stop.** Done.

No app to open and no "Photo Library / Take Photo / Choose File" menu. iOS
shows that menu for every web photo picker and no web app can skip it, which
is why this route exists. The same steps are in Catch → **Settings → Share
from Photos**, with copy buttons for the key and the two URLs.

## How it works

The Shortcut sends each screenshot to `POST /api/captures/draft`, which adds
it to your open draft (creating one if needed). Then it records your voice and
sends it to `POST /api/captures/draft/finish`, which files the whole capture.

- If you skip or abandon the recording, the screenshots are filed on their own
  after 10 minutes. Nothing is lost.
- If the finish is retried (weak signal), you get the same capture back, not a
  second one.
- A draft stays open for 10 minutes after its last screenshot, so screenshots
  from two separate shares within that time join one capture.

## Set it up (about 5 minutes, once)

1. **Key.** Catch → Settings → Share from Photos → **Create key** → Copy key.
   It looks like `Bearer catch_…` and is shown once.
2. **Shortcuts app** → **+** → name it **Catch**. Tap **ⓘ** → **Show in Share
   Sheet** on; receive **Images**.
3. **Repeat with Each** → *Shortcut Input*. Inside the repeat:
   - **Convert Image** → *Repeat Item* → **JPEG** (iPhone camera photos are
     HEIC, which is refused; screenshots are fine either way).
   - **Get Contents of URL**
     - URL: `https://catch-maxsenica-sys.fly.dev/api/captures/draft`
     - Method: **POST**
     - Headers: `Authorization` = the key from step 1
     - Request Body: **Form** → add a **File** field `image` = *Converted Image*
4. After **End Repeat**: **Record Audio** → Start Recording **Immediately**,
   Finish Recording **On Tap**.
5. **Get Contents of URL**
   - URL: `https://catch-maxsenica-sys.fly.dev/api/captures/draft/finish`
   - Method **POST**, same `Authorization` header
   - Request Body: **Form** → **File** field `audio` = *Recorded Audio*
   - Optional: a **Text** field `category` (`coaching`, `lead`, `instagram`,
     `program`, `followup`, `partnership`). Leave it out and Catch decides.
6. **Show Notification** → "Caught".

## When it fails

The Shortcut shows the server's message. `401`: the key was revoked or
mistyped, so make another in Settings. `415`: a photo that was not converted to
JPEG (check step 3). Anything that reached the server is in Catch → Inbox.
