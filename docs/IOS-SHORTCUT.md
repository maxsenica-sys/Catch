# iPhone: screenshot → Catch in one tap

iOS does not let web apps appear in the share sheet. The app itself is the
fastest route for most captures (open Catch → Screenshots → hold mic). For the
moments you want to send a screenshot *without opening anything*, an iOS
Shortcut can post it straight to the API.

## Make a token

Catch → Settings → API tokens → **New** → name it "iPhone Shortcut" → copy it.

## Build the Shortcut (about five minutes)

Shortcuts app → **+** → name it **Catch it**.

1. **Receive** *Images* and *Screenshots* from **Share Sheet**.
   (Shortcut settings → "Show in Share Sheet" on.)
2. **Choose from Menu**, prompt "Category", items:
   `Auto`, `Coaching`, `Lead`, `Instagram`, `Follow-up`. In each branch,
   **Text** with the lowercase key: `auto`, `coaching`, `lead`, `instagram`,
   `followup`. Set the menu result to a variable **Category**.
3. **Dictate Text**, *Stop Listening: After Pause*. Set variable **Note**.
   (iOS transcribes on the phone, so this goes in the `note` field and
   works even without an OpenAI key.)
4. **Convert Image** (Shortcut Input) to **JPEG**: HEIC is refused by the
   server.
5. **Get Contents of URL**
   - URL: `https://<your catch address>/api/captures`
   - Method: **POST**
   - Headers: `Authorization` = `Bearer <your token>`
   - Request Body: **Form**
     - `image` (File) = Converted Image
     - `category` (Text) = Category
     - `note` (Text) = Note
     - `client_id` (Text) = *Current Date* formatted as ISO 8601 + a random
       number (any unique string works)
6. **Show Notification**: "Caught".

Use it: take a screenshot → tap the thumbnail → Share → **Catch it** → pick a
category → talk → done.

**Back Tap** (Settings → Accessibility → Touch → Back Tap → Double Tap →
your Shortcut) can run it from anywhere, but Back Tap passes no input. Pair it
with a version of the Shortcut whose first action is **Get Latest
Screenshots** (count 1).

## When it fails

The Shortcut shows the server's error text. `401` means the token was revoked
or mistyped; `415` means a non-JPEG image got through (check step 4).
Anything that reached the server is in Catch → Inbox.
