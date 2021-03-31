const rankingdiv = document.getElementById('ranking');
var get_ranking = new XMLHttpRequest();
get_ranking.onreadystatechange = function() {
    if (this.readyState == 4 && this.status == 200) {
        result = get_ranking.responseText;
        rankingdiv.innerHTML = '<pre style="border: 1px solid gray; padding: 2px;">' + result + '</pre>';
    }
};
get_ranking.open("GET", "/rankings", true);
get_ranking.send();