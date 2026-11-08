# Restaurant onboarding (#208)

How a new restaurant gets onto the platform, with the decisions the project owner made (November 2026). The backend applies these rules; the apps only show what the backend returns.

## Owner decisions

- **Legal details:** only the **legal name** is required to submit. The commercial registration number and the tax card number are optional; the reviewer can ask for them outside the app.
- **One restaurant per owner account**, for now. A second create is refused (`409 RestaurantLimitReached`); branches can be opened up later. Owners who had several restaurants before this rule keep them.

## The application

An application has its own status, separate from the operating status (`OPEN`, `BUSY`, `CLOSED`, `SUSPENDED`), so an approval and a suspension never fight over one value.

| Application | Customers see it | The owner can |
| --- | --- | --- |
| `DRAFT` (new restaurant) | No | fill in the details and the menu, submit |
| `SUBMITTED` | No | wait for the review; edit the menu, description, photos, phone and cuisine labels |
| `APPROVED` | Yes | open it (`OPEN` or `BUSY`) and run it |
| `REJECTED` | No | read the reviewer's note, fix the application and submit again |

- **To submit**, the restaurant needs its legal name, a contact phone (an Egyptian mobile), its location on the map, and a menu customers can order from: at least one category and one available item. Otherwise the answer lists what is missing.
- **Until it is approved**, a restaurant is not listed, its page doesn't exist for customers, checkout refuses it, and the owner can't open it (`409 RestaurantNotApproved`). The owner can prepare the menu in the meantime.
- **The review:** staff with the `onboarding.review` permission approve or reject the exact submission they looked at. A rejection always carries a note telling the owner what to fix. An approval re-checks that the application and the menu are still complete. Every decision is kept.
- **What can change when:** the legal details only before approval (after that, through support); the name, address and location not while a reviewer is looking at them; the description, photos, contact phone and cuisine labels at any time.
- **Private details:** the legal name, registration numbers and contact phone are never shown to customers. The contact phone is how a driver reaches the restaurant during a delivery (#211).
- **Existing restaurants** were approved automatically when this rule started, so nothing changed for them.
