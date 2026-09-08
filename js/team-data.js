/* ============================================================
   ELIAS LAB — TEAM MEMBERS
   ------------------------------------------------------------
   THIS IS THE ONLY FILE YOU EDIT TO ADD / CHANGE LAB MEMBERS.

   For each person, fill in the lines between the { } braces.
   To add someone, copy an entire block (from { to },) and paste it
   below the last one. To remove someone, delete their block.

   photo:      the file name of their picture, saved in  assets/team/
               e.g. "Rina-Ghadban.jpg"  ->  assets/team/Rina-Ghadban.jpg
               Leave it as ""  and their initials show in a circle instead.
   photoHover: OPTIONAL second picture (e.g. the illustrated version) that
               fades in when someone hovers over the photo. Same folder.
               Leave it as ""  and the photo simply doesn't change.
   linkedin:   paste the LinkedIn address, e.g.
               "linkedin.com/in/rina-ghadban-00121b266"
               Leave it as ""  and no LinkedIn icon appears.
   note:       OPTIONAL single short line under the name.
   bio:        OPTIONAL paragraphs (PI only). An empty list [] shows none.

   Keep every quote mark " and every comma exactly where they are.
   ============================================================ */

window.ELIAS_TEAM = {

  /* ---- The PI (shown large, at the top) ---- */
  pi: {
    name: "Dr. Amer Elias",
    role: "Principal Investigator & Founder",
    photo: "amer-elias.jpg",
    photoHover: "amer-elias-art.webp",
    linkedin: "linkedin.com/in/amer-elias-762a0998",
    bio: []          // intentionally empty — photo, name and LinkedIn only
  },

  /* ---- Everyone else (shown as cards below the PI) ---- */
  members: [

    {
      name: "Dr. Hala Kassis",
      role: "Collaborating Fellow",
      photo: "Hala-Kassis.jpg",
      photoHover: "Hala-Kassis-art.jpg",
      linkedin: "linkedin.com/in/hala-kassis-574699162",
      note: ""
    },

    {
      name: "Dr. Kathelina Kristollari",
      role: "Postdoctoral Fellow",
      photo: "Kathelina-Kristollari.jpg",
      photoHover: "Kathelina-Kristollari-art.jpg",
      linkedin: "linkedin.com/in/kathelina-kristollari",
      note: "Co-supervised with Prof. Shani Stern"
    },

    {
      name: "Rina Ghadban",
      role: "MSc Student",
      photo: "Rina-Ghadban.jpg",
      photoHover: "Rina-Ghadban-art.jpg",
      linkedin: "linkedin.com/in/rina-ghadban-00121b266",
      note: ""
    }

  ]
};
